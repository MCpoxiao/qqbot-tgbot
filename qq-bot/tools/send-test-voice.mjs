/**
 * 用**小笛自己的代码路径**发一条私聊 AI 语音,验证私聊 record 段能否被 QQ 接受。
 *
 * 走的就是 src/onebot.mjs 的 sendAiVoice()：
 *   get_ai_record(拿 URL) → send_private_msg([{type:'record', file:url}])
 *
 * 用法:node tools/send-test-voice.mjs ["要念的文字"]
 * ⚠️ 这会**真的**给主人发一条 QQ 语音消息；并且由于 `get_ai_record` 的副作用，
 * **同时会在 fallback 群里留下一条语音**（机制见 probe-ai-voice.mjs 顶部说明）。
 * 只在 fallback 是「自己的专用群」时使用。
 */
import { OneBot } from '../src/onebot.mjs';

const TARGET = { type: 'private', id: 10000000 };
const FALLBACK_GROUP = 1035435671;
const CHARACTER = process.argv[3] ?? 'lucy-voice-xueling';
const TEXT = process.argv[2] ?? '这是一条测试语音，用来验证私聊路径。';

const ob = new OneBot({ url: 'ws://127.0.0.1:3001' });
ob.on('log', (l) => console.error(`[${l.level}] ${l.msg}`));

ob.on('open', async () => {
  console.error('已连上 OneBot，开始发送…');
  const ok = await ob.sendAiVoice(TARGET, TEXT, CHARACTER, { fallbackGroupId: FALLBACK_GROUP });
  console.log(JSON.stringify({ ok, target: TARGET.id, character: CHARACTER, text: TEXT }, null, 2));
  process.exit(ok ? 0 : 1);
});

ob.on('error', (e) => {
  console.error('连接错误:', e?.message ?? String(e));
});

ob.connect();
setTimeout(() => {
  console.error('超时退出');
  process.exit(2);
}, 60000);
