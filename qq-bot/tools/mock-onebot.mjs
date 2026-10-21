import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

/**
 * 一个只够用的 OneBot 11 协议端替身（WebSocket 服务端）。
 *
 * 目的：在**不碰 QQ 账号**的前提下，把「事件进来 → 规则判定 → 调模型 → 发回去」
 * 整条链路跑通并断言。等真实 NapCat 上线时，只需把 bot 的 onebot.url 指过去。
 *
 * 只支持单帧文本消息（不分片、无压缩）——测试用足够了。
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MOCK_SELF_ID = '10000';

class WSConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.handlers = new Map();
    socket.on('data', (c) => this.#push(c));
    socket.on('close', () => this.#emit('close'));
    socket.on('error', () => this.#emit('close'));
  }

  on(ev, fn) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, []);
    this.handlers.get(ev).push(fn);
    return this;
  }

  #emit(ev, ...args) {
    for (const fn of this.handlers.get(ev) ?? []) fn(...args);
  }

  #push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.subarray(off, off + 4);
        off += 4;
      }
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      this.buf = b.subarray(off + len);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.#frame(payload, 0xa);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) this.#emit('message', payload.toString('utf8'));
    }
  }

  #frame(payload, opcode) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      /* 对端已断开 */
    }
  }

  send(text) {
    this.#frame(Buffer.from(text, 'utf8'), 0x1);
  }

  close() {
    try {
      this.socket.end();
    } catch {
      /* 忽略 */
    }
  }
}

export function createMockOneBot({ port = 3901, host = '127.0.0.1', log = () => {} } = {}) {
  const conns = new Set();
  const sent = []; // 机器人通过接口发出去的所有调用

  const broadcast = (evt) => {
    const raw = JSON.stringify(evt);
    for (const c of conns) c.send(raw);
  };

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/inject')) {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        try {
          broadcast(JSON.parse(body || '{}'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400);
          res.end(String(err.message));
        }
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('mock onebot ok\n');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );

    const conn = new WSConn(socket);
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    conn.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg.action) return;
      sent.push(msg);
      // 失败注入：用来测"图片发失败要退回纯文本"这类兜底路径
      if (typeof api.failOn === 'function' && api.failOn({ action: msg.action, params: msg.params })) {
        log(`  协议端按注入规则拒绝了 ${msg.action}`);
        conn.send(JSON.stringify({ status: 'failed', retcode: 1404, message: 'mock: 按注入规则拒绝', echo: msg.echo }));
        return;
      }
      log(`  协议端收到调用 ${msg.action} ${JSON.stringify(msg.params)}`);

      // **真正建模的那几个查询类动作**：以前所有 action 都回一个
      // `{message_id:N}`，于是 `get_group_list` 返回的不是数组，
      // 「群列表」这类命令在端到端测试里根本测不出来——真实出现过
      // "单测全绿、接线是错的"（命令没被拦截、落到模型那边）。
      if (msg.action === 'get_group_list') {
        conn.send(
          JSON.stringify({
            status: 'ok',
            retcode: 0,
            echo: msg.echo,
            data: [
              { group_id: 20001, group_name: '测试群', member_count: 3 },
              { group_id: 20002, group_name: '另一个群', member_count: 9 },
            ],
          }),
        );
        return;
      }
      if (msg.action === 'set_group_leave') {
        conn.send(JSON.stringify({ status: 'ok', retcode: 0, echo: msg.echo, data: null }));
        return;
      }
      /**
       * **发文件**（2026-10-11 加的「漫画打包」用）—— 这里也**照真实 NapCat 的脾气建模**：
       * `file` 必须是 `file://` 地址（或绝对路径），`name` 不能为空；
       * 缺参数就回 `retcode 1200 文件消息缺少参数`（真机上就是这个错，
       * 见 `memory/lessons.md` 的「内部结构 ≠ 线格式」那条）。
       * 回一个笼统的 ok 就会让"字段写错"这类 bug 在自测里看不出来。
       */
      if (msg.action === 'upload_private_file' || msg.action === 'upload_group_file') {
        const p = msg.params ?? {};
        const targetOk = msg.action === 'upload_private_file' ? Boolean(p.user_id) : Boolean(p.group_id);
        const fileOk = typeof p.file === 'string' && (/^file:\/\//i.test(p.file) || /^[A-Za-z]:[\\/]/.test(p.file));
        if (!targetOk || !fileOk || !p.name) {
          conn.send(
            JSON.stringify({
              status: 'failed',
              retcode: 1200,
              message: 'mock: 文件消息缺少参数（file 要用 file:// 且 name 不能为空）',
              echo: msg.echo,
            }),
          );
          return;
        }
        conn.send(JSON.stringify({ status: 'ok', retcode: 0, echo: msg.echo, data: { file_id: 'mock-file-1' } }));
        return;
      }

      conn.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: sent.length }, echo: msg.echo }));
    });

    conn.send(
      JSON.stringify({
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: 'connect',
        self_id: MOCK_SELF_ID,
        time: Math.floor(Date.now() / 1000),
      }),
    );
    log('  机器人已接入协议端替身');
  });

  const api = {
    port,
    url: `ws://${host}:${port}`,
    sent,
    /** 失败注入钩子：设成一个函数就能让协议端按条件拒绝调用，用来测兜底路径。 */
    failOn: null,
    /** 退到下一次发送之前一直等 */
    waitForSend(predicate = () => true, timeoutMs = 8000) {
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const tick = () => {
          const hit = sent.find(predicate);
          if (hit) return resolve(hit);
          if (Date.now() - started > timeoutMs) return reject(new Error('等待机器人发送超时'));
          setTimeout(tick, 50);
        };
        tick();
      });
    },
    /** 等第 n 条之后的发送 */
    waitForNewSend(fromIndex, predicate = () => true, timeoutMs = 8000) {
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const tick = () => {
          const hit = sent.slice(fromIndex).find(predicate);
          if (hit) return resolve(hit);
          if (Date.now() - started > timeoutMs) return reject(new Error('等待机器人发送超时'));
          setTimeout(tick, 50);
        };
        tick();
      });
    },
    inject: broadcast,
    privateEvent(userId, text, extra = {}) {
      broadcast({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: Math.floor(Math.random() * 1e6),
        user_id: Number(userId),
        self_id: Number(MOCK_SELF_ID),
        raw_message: text,
        message: [{ type: 'text', data: { text } }],
        sender: { user_id: Number(userId), nickname: `用户${userId}` },
        time: Math.floor(Date.now() / 1000),
        ...extra,
      });
    },
    groupEvent(groupId, userId, text, { mention = true } = {}) {
      const message = mention
        ? [
            { type: 'at', data: { qq: MOCK_SELF_ID } },
            { type: 'text', data: { text: ` ${text}` } },
          ]
        : [{ type: 'text', data: { text } }];
      broadcast({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: Math.floor(Math.random() * 1e6),
        group_id: Number(groupId),
        user_id: Number(userId),
        self_id: Number(MOCK_SELF_ID),
        raw_message: (mention ? `[CQ:at,qq=${MOCK_SELF_ID}] ` : '') + text,
        message,
        sender: { user_id: Number(userId), nickname: `群友${userId}` },
        time: Math.floor(Date.now() / 1000),
      });
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(api));
      });
    },
    close() {
      for (const c of conns) c.close();
      conns.clear();
      return new Promise((resolve) => server.close(resolve));
    },
  };

  return api;
}

// 直接运行：起一个替身，并提供一个注入入口，方便手工试
if (process.argv[1] && process.argv[1].endsWith('mock-onebot.mjs')) {
  const port = Number(process.env.MOCK_PORT ?? 3901);
  const mock = createMockOneBot({ port, log: (m) => console.log(`[mock] ${m}`) });
  await mock.listen();
  console.log(`[mock] OneBot 11 替身已监听 ${mock.url}`);
  console.log(`[mock] 注入一条私聊消息：`);
  console.log(
    `  curl.exe -s -X POST http://127.0.0.1:${port}/inject -H "content-type: application/json" ` +
      `-d "{\\"post_type\\":\\"message\\",\\"message_type\\":\\"private\\",\\"user_id\\":10001,\\"self_id\\":10000,\\"message\\":[{\\"type\\":\\"text\\",\\"data\\":{\\"text\\":\\"你好\\"}}]}"`,
  );
}
