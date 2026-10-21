/**
 * 查某个群最近的消息 —— 用来**证实/证伪**一件我判断可能错了的事。
 *
 * 背景：QQ 的 AI 语音是「群功能」。`get_ai_record` 名义上是「生成音频并返回 URL」，
 * 但它可能必须先在那个群真的发出一条语音、才能拿到 URL。若真如此，
 * 那么**每次私聊发语音都会在 fallback 群里留下一条声音** ——
 * 而我此前在 probe/send 脚本里写的是「不会向任何人发消息」，那就写错了。
 *
 * 用法:node tools/check-group-history.mjs [group_id] [count]
 */
const url = process.env.ONEBOT_URL || 'ws://127.0.0.1:3001';
const groupId = Number(process.argv[2] ?? 1035435671);
const count = Number(process.argv[3] ?? 20);

const ws = new WebSocket(url);
let seq = 0;
const pending = new Map();

function call(action, params = {}, timeoutMs = 20000) {
  const echo = `h${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(echo);
      reject(new Error(`${action} 超时`));
    }, timeoutMs);
    pending.set(echo, { resolve, reject, timer });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

ws.addEventListener('message', (ev) => {
  let m;
  try {
    m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  } catch {
    return;
  }
  if (!m.echo) return;
  const p = pending.get(m.echo);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(m.echo);
  p.resolve(m);
});

ws.addEventListener('open', async () => {
  let r;
  try {
    r = await call('get_group_msg_history', { group_id: groupId, count });
  } catch (err) {
    console.error('查询失败:', err.message);
    ws.close();
    setTimeout(() => process.exit(1), 200);
    return;
  }

  const list = Array.isArray(r?.data?.messages) ? r.data.messages : Array.isArray(r?.data) ? r.data : null;
  console.log(`retcode=${r?.retcode} status=${r?.status} 取到 ${list ? list.length : 0} 条`);

  if (!list) {
    console.log('返回结构不认识，原始内容（截断）：');
    console.log(JSON.stringify(r, null, 2).slice(0, 1500));
  } else {
    for (const msg of list) {
      const segs = (msg.message ?? [])
        .map((s) => (s.type === 'text' ? `文本「${(s.data?.text ?? '').slice(0, 40)}」` : s.type))
        .join(' + ');
      const t = msg.time ? new Date(msg.time * 1000).toLocaleString('zh-CN') : '?';
      console.log(`  [${t}] ${msg.sender?.nickname ?? msg.user_id ?? '?'} (${msg.sender?.user_id ?? '?'}): ${segs}`);
    }
  }

  ws.close();
  setTimeout(() => process.exit(0), 300);
});

setTimeout(() => {
  console.error('总超时');
  process.exit(2);
}, 60000);
