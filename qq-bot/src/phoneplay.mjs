/**
 * **她自己玩手机**（2026-10-19 用户要求：「怎么让她自己玩，现在这是我说干啥她干啥」）。
 *
 * 和「冲浪」一个思路 ✓：**定时 → 自己判时机 → 干几件小事 → 跟主人说一句** ✓，
 * 区别只是它动的是手机（ADB ✓）而不是网上冲浪。
 *
 * ⚠️ 代价必须焊死 ✗：一次 `look` ≈ 1100 token ✓ ⇒
 *    **每次最多 4 步、每天最多 2 次、两次间隔 ≥60 分钟** ✓（全部可配 ✓，但默认就这么保守 ✓）。
 *
 * ⚠️ 只碰模拟器 ✓（`phone.mjs` 的 `pick()` 已经只认 `emulator-*` ✓）。
 */
import { readFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 截图 → 识图 → 文字 + 元素表（和 tools.mjs 里 phone_look 同一套，但这里要拿"结构化"的元素 ✓） */
async function lookOnce(phone, cfg, askWithImage, question, meter) {
  const shot = await phone.screenshot();
  if (!shot.ok) return { ok: false, err: shot.err };
  // ⚠️ 2026-10-20：游戏画面（Unity）没有元素表 + 原图 2.7MB 会让识图超时 ✗
  //    ⇒ JPEG + 200px 网格（不缩放 ⇒ 网格坐标 = 真实坐标 ✓）
  const { toVisionJpeg } = await import('./shotsize.mjs');
  const vjpg = await toVisionJpeg(shot.png, { grid: 200 });
  const imgB64 = (vjpg ?? shot.png).toString('base64');
  const imgMime = vjpg ? 'image/jpeg' : 'image/png';
  const dump = await phone.uiDump({ max: 30 });
  const list = dump.ok ? dump.items : [];
  const listTxt = list.length
    ? list.map((it) => '「' + it.text + '」(' + it.x + ',' + it.y + ')').join(' ')
    : '（没有元素表 —— 游戏画面，照 200px 红网格读坐标 ✓）';
  const desc = await askWithImage(cfg, {
    system: '你看安卓手机截图。只描述真的看到的东西，简短。',
    prompt: '这是安卓手机屏幕。一句话说清现在是什么页面/在干什么。' + (question ? '\n' + question : '') + '\n可点元素：' + listTxt,
    imageBase64: imgB64,
    mime: imgMime,
    maxTokens: 200,
  });
  if (meter && desc?.usage?.total_tokens) meter.tokens += desc.usage.total_tokens;
  return { ok: true, text: String(desc?.text ?? '').trim(), items: list, bytes: shot.png.length };
}

/**
 * 跑一次"自己玩"。
 * @param {object} p
 * @param {object} p.phone      createPhone() 的实例
 * @param {object} p.cfg        配置（含 phone.play）
 * @param {Function} p.ask      模型（(messages, {system}) => {text}）
 * @param {Function} p.askWithImage
 * @param {Function} p.send     发消息给主人：({ target, key, text, label }) => Promise<bool>
 * @param {object} p.memory     机器人自己的记忆（用来记日记，可选）
 * @param {object} p.state      运行态（存 lastAt / count）
 * @param {object} p.log
 * @param {boolean} p.force     忽略时机判断（面板/手动触发）
 */
export async function runPlayEpisode({ phone, cfg, ask, askWithImage, send, memory = null, state = null, log = console, force = false } = {}) {
  const p = cfg?.phone?.play ?? {};
  const enabled = p.enabled ?? false;
  if (!enabled && !force) return { ok: false, why: '没启用（phone.play.enabled）' };

  // ── 限频（硬上限 ✓）──
  const now = Date.now();
  const day = new Date().toDateString();
  const st = state ?? {};
  if (st.day !== day) { st.day = day; st.count = 0; }
  const dailyMax = Number(p.dailyMax ?? 2);
  const gapMs = Math.max(10, Number(p.gapMinutes ?? 60)) * 60000;
  if (!force) {
    if ((st.count ?? 0) >= dailyMax) return { ok: false, why: `今天已经玩了 ${st.count} 次（上限 ${dailyMax}）` };
    if (now - (st.lastAt ?? 0) < gapMs) return { ok: false, why: '离上次玩还不够久' };
  }
  // ⚠️ 用户要求「玩一次限制在 1 块左右」✓ ⇒ token 预算（≈50k token ≈ 1 元 ✓，超了立刻收尾 ✓）
  const budget = Math.max(5000, Number(p.budgetTokens ?? 50000));
  const meter = { tokens: 0 };
  const withMeter = async (promise) => { const r = await promise; if (r?.usage?.total_tokens) meter.tokens += r.usage.total_tokens; return r; };
  const maxSteps = Math.max(1, Math.min(40, Number(p.maxSteps ?? 20)));
  // 2026-10-19：真正的瓶颈是**时间**不是钱 ✓（一步 ≈8 秒）
  const maxMs = Math.max(1, Number(p.maxMinutes ?? 12)) * 60000;
  const startedAt = Date.now(); // 2026-10-19：用户「四步不够，玩游戏不止四步」✓ 提到 20 步，真正闸门是下面的 token 预算 ✓
  const apps = Array.isArray(p.apps) && p.apps.length ? p.apps : ['com.RoamingStar.BlueArchive'];

  let pk = await phone.pick();
  if (!pk.ok) {
    // ⚠️ 用户要求：**没开就自己打开雷电** ✓
    log.info?.('[手机玩] 手机不通（' + pk.err + '）→ 自己开模拟器');
    const st2 = await phone.start();
    if (!st2.ok) return { ok: false, why: '模拟器起不来：' + st2.err };
    pk = await phone.pick();
    if (!pk.ok) return { ok: false, why: '开了但还是连不上：' + pk.err };
  }
  log.info?.('[手机玩] 开始（设备 ' + pk.serial + '）');

  // ── 挑一个 App 打开 ──
  const app = apps[Math.floor(Math.random() * apps.length)];
  const opened = await phone.open(app);
  if (!opened.ok) return { ok: false, why: '打不开 ' + app + '：' + opened.err };
  await sleep(2500); // 等它启动

  // ── 走最多 maxSteps 步 ──
  const trail = [];
  let lastPage = '';
  for (let i = 0; i < maxSteps; i += 1) {
    if (meter.tokens > budget) { trail.push('（预算用完了，收尾）'); break; }
    if (Date.now() - startedAt > maxMs) { trail.push('（玩够久了，收尾）'); break; }
    const look = await lookOnce(phone, cfg, askWithImage, i === 0 ? '刚打开这个 App。' : '刚点了一下。', meter);
    if (!look.ok) { trail.push('（看不到屏幕：' + look.err + '）'); break; }
    lastPage = look.text;
    trail.push(look.text.slice(0, 60));
    const items = look.items.slice(0, 14).map((it) => '·「' + it.text + '」(' + it.x + ',' + it.y + ')').join('\n');
    const decided = await withMeter(ask(
      [
        { role: 'user', content: '你现在自己在玩手机。现在是：' + look.text + '\n可点元素：\n' + (items || '（无）') },
        { role: 'user', content: '决定下一步：回一行 `点 文字`（必须从上面元素里选，原样文字）；或者回 `停` 表示不玩了。别解释。' },
      ],
      { system: '你在玩手机，像人一样随手点点。只输出一行：`点 <元素文字>` 或 `停`。' },
    ), meter);
    const line = String(decided?.text ?? '').trim();
    const m = line.match(/^点\s*(.+)$/) ?? line.match(/点\s*(.+)/);
    if (!m) { trail.push('（决定：停 / ' + line.slice(0, 20) + '）'); break; }
    const want = m[1].trim();
    const hit = look.items.find((it) => it.text === want) ?? look.items.find((it) => it.text.includes(want) || want.includes(it.text));
    if (!hit) { trail.push('（想点「' + want + '」但没这个元素）'); break; }
    trail.push('点「' + hit.text + '」(' + hit.x + ',' + hit.y + ')');
    const t = await phone.tap(hit.x, hit.y);
    if (!t.ok) { trail.push('（点失败：' + t.err + '）'); break; }
    await sleep(1400);
  }

  const playedSec = Math.round((Date.now() - now) / 1000);
  st.lastAt = Date.now();
  st.count = (st.count ?? 0) + 1;
  log.info?.('[手机玩] 结束（' + trail.length + ' 步 / ' + playedSec + ' 秒）：' + trail.join(' → ').slice(0, 200));

  // ── 跟主人说一句（他自己会看到）──
  const say = await ask(
    [
      {
        role: 'user',
        content:
          '你刚才自己在手机上玩了一会儿。经过：' + trail.join(' → ') + '\n最后屏幕：' + lastPage.slice(0, 120) +
          '\n用一两句跟他随口说一声（像邀他一起/分享发现那样，别写成报告）。',
      },
    ],
    { system: '你是小笛，说话短、口语、带点撒娇。不要列表、不要 Markdown。' },
  );
  const text = String(say?.text ?? '').trim().slice(0, 200) || '刚玩了会儿手机，你要不要来一起喵';
  if (typeof send === 'function') await send({ text, label: '小笛·玩手机' });
  memory?.writeDiary?.('', undefined, '自己玩手机：' + trail.slice(-2).join(' → ').slice(0, 80));
  return { ok: true, app, steps: trail.length, text, trail, playedSec };
}
