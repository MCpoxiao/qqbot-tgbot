/**
 * **Telegram 的"协议端替身"**（2026-10-14 加）。
 *
 * 作用与 `tools/mock-onebot.mjs` 里的 OneBot 替身一样 ✓：
 * 起一个**本地 HTTP 服务**冒充 `https://api.telegram.org` ✓，于是
 * `src/telegram.mjs` 能在**完全离线**的情况下被端到端测到（长轮询、发送、打字状态 ✓），
 * 不用等真机、不用联网、也不会碰到真 token ✗（测试里用的都是假 token ✓）。
 *
 * 只实现我们真正用到的那几个方法 ✓：`getMe` / `getUpdates` / `sendMessage` /
 * `sendChatAction` / `sendPhoto` / `sendDocument` / `leaveChat` ✓。
 */

import { createServer } from 'node:http';

export function createMockTelegram({ port = 0, token = 'test:token', log = () => {} } = {}) {
  /** 假 token 也要参与路径匹配（这样能验证"URL 里带 token"这条约定 ✓）。 */
  const state = {
    token,
    me: { id: 10001, is_bot: true, first_name: '小笛', username: 'xiaodi_test_bot' },
    /** 待投递的 update（`getUpdates` 会取走 ✓）。 */
    updates: [],
    /** 收到的所有调用（便于断言"她到底发了什么"✓）。 */
    calls: [],
    sent: [],
    actions: [],
    nextMessageId: 5000,
    nextUpdateId: 1,
    getUpdatesCount: 0,
    /** 假图片的字节（下载测试用 ✓）。 */
    fakeBytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9]),
    downloaded: [],
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  const reply = (res, obj, status = 200) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    /** 文件下载：/file/bot<token>/<path>（真 TG 就是这么给的 ✓，带 token ✓）。 */
    const fm = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (fm) {
      if (fm[1] !== state.token) return reply(res, { ok: false, description: 'Unauthorized' }, 401);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': state.fakeBytes.length });
      res.end(state.fakeBytes);
      return undefined;
    }
    const m = url.pathname.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
    if (!m) return reply(res, { ok: false, description: 'not found' }, 404);
    const [, gotToken, method] = m;
    if (gotToken !== state.token) return reply(res, { ok: false, error_code: 401, description: 'Unauthorized' }, 401);
    const raw = await readBody(req);
    let params = {};
    const ctype = String(req.headers['content-type'] ?? '');
    if (ctype.includes('application/json')) {
      try {
        params = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        params = {};
      }
    } else {
      // multipart：只抠出 chat_id 够断言用了 ✓（不解析文件本体 ✗）
      const text = raw.toString('latin1');
      params = { _multipart: true, chat_id: String(text.match(/name="chat_id"\r?\n\r?\n([^\r\n]+)/)?.[1] ?? ''), _bytes: raw.length };
    }
    state.calls.push({ method, params });

    if (method === 'getMe') return reply(res, { ok: true, result: state.me });

    if (method === 'getFile') {
      // 假文件：一小段字节，够验证「下载 → 落盘 → file://路径」这条链 ✓
      const p = 'photos/' + String(params.file_id ?? 'x') + '.jpg';
      state.downloaded.push(p);
      return reply(res, { ok: true, result: { file_id: String(params.file_id ?? ''), file_unique_id: 'u1', file_size: state.fakeBytes.length, file_path: p } });
    }

    if (method === 'getUpdates') {
      state.getUpdatesCount += 1;
      const offset = Number(params.offset ?? 0);
      const out = state.updates.filter((u) => Number(u.update_id) >= offset);
      state.updates = state.updates.filter((u) => Number(u.update_id) < offset);
      log(`[mock-tg] getUpdates → ${out.length} 条（第 ${state.getUpdatesCount} 次轮询）`);
      return reply(res, { ok: true, result: out });
    }

    if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument' || method === 'sendVoice') {
      const id = state.nextMessageId++;
      const item = { method, chat_id: String(params.chat_id ?? ''), text: String(params.text ?? ''), caption: String(params.caption ?? ''), photo: params.photo ?? '', document: params.document ?? '', voice: params.voice ?? '', reply_to: params.reply_parameters?.message_id ?? null, message_id: id, bytes: params._bytes ?? 0 };
      state.sent.push(item);
      log(`[mock-tg] ${method} → chat ${item.chat_id}：${(item.text || item.caption || item.photo || item.document || '(文件)').slice(0, 60)}`);
      return reply(res, { ok: true, result: { message_id: id, chat: { id: Number(params.chat_id) || 0 }, date: Math.floor(Date.now() / 1000) } });
    }

    if (method === 'sendChatAction') {
      state.actions.push({ chat_id: String(params.chat_id ?? ''), action: String(params.action ?? '') });
      log(`[mock-tg] sendChatAction → chat ${params.chat_id}：${params.action}`);
      return reply(res, { ok: true, result: true });
    }

    if (method === 'leaveChat') return reply(res, { ok: true, result: true });

    // 其它一律"成功但空"（免得测试因为没实现的方法挂掉 ✓）
    return reply(res, { ok: true, result: true });
  });

  return {
    state,
    server,
    async listen() {
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      const addr = server.address();
      this.url = `http://127.0.0.1:${addr.port}`;
      log(`[mock-tg] 已启动：${this.url}`);
      return this;
    },
    async close() {
      await new Promise((r) => server.close(r));
    },
    /** ⚠️ **不带 token**（和真实现一致：URL 里才有 token ✗）。 */
    url: '',
    baseWithToken() {
      return `${this.url}/bot${state.token}`;
    },
    /** 推一条"用户发来的文字"，返回 update_id ✓。 */
    pushText(text, { userId = 999, nickname = '老大', chatType = 'private', chatId = 0 } = {}) {
      const id = chatType === 'private' ? userId : chatId || -1000;
      const u = {
        update_id: state.nextUpdateId++,
        message: {
          message_id: state.nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id, type: chatType },
          from: { id: userId, first_name: nickname, is_bot: false },
          text,
        },
      };
      state.updates.push(u);
      return u.update_id;
    },
    /**
     * **推一条「引用着某条」的消息**（2026-10-14 加，为「引用回复」✓）。
     * TG 的 update 里被引用那条**原文直接就在** `reply_to_message` 里 ✓
     * （不用像 QQ 那样再调 get_msg 去查 ✓）。
     */
    pushReply(text, { quoted = '', quotedMessageId = null, userId = 999, nickname = '老大' } = {}) {
      const u = {
        update_id: state.nextUpdateId++,
        message: {
          message_id: state.nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: userId, type: 'private' },
          from: { id: userId, first_name: nickname, is_bot: false },
          text,
          reply_to_message: {
            message_id: quotedMessageId ?? state.nextMessageId++,
            from: { id: userId, first_name: nickname },
            text: quoted,
          },
        },
      };
      state.updates.push(u);
      return u.update_id;
    },

    /** 推一条"用户发来的图"（带 caption ✓）。 */
    pushPhoto(fileId = 'ph1', { caption = '', userId = 999, nickname = '老大' } = {}) {
      const u = {
        update_id: state.nextUpdateId++,
        message: {
          message_id: state.nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: userId, type: 'private' },
          from: { id: userId, first_name: nickname, is_bot: false },
          caption,
          photo: [{ file_id: `${fileId}_small`, width: 90 }, { file_id: fileId, width: 1280 }],
        },
      };
      state.updates.push(u);
      return u.update_id;
    },
    /** 等她发出新消息（轮询式等待 ✓，和 OneBot mock 的用法一致 ✓）。 */
    async waitForNewSend(mark, pred = () => true, timeoutMs = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const fresh = state.sent.slice(mark).filter(pred);
        if (fresh.length) return fresh[0];
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    },
    async waitForAction(mark, timeoutMs = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (state.actions.length > mark) return state.actions[mark];
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    },
  };
}
