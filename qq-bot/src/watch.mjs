/**
 * 「看懂一个视频，再决定要不要发给主人」。
 *
 * 分辨率这件事得说在前面（实测，见 `src/bilibili.mjs`）：
 *   · B站只给一张**雪碧图**做画面预览：100 格、**每格 160×90**、约 5 秒一格；
 *   · 所以**拿不到 720p 的帧** —— 把 160×90 放大到 720p 只是"更大的糊图"，信息量不变 ✗；
 *   · 真正能高清的是**封面**（B站图床支持 `@1920w_1080h` 取大图）✓。
 * 结论：**判断以字幕为主**（视频里说的话，逐字稿，信息量最大），画面为辅（封面 + 雪碧图看场景）。
 *
 * 这个模块只做"判断"和"拼消息"，**不碰网络也不碰 onebot** —— 依赖都从外面注入，方便测。
 */

/** 把字幕压成一段有上限的文本（太长的视频只取前 N 行 + 结尾几行，别把上下文塞爆）。 */
export function trimSubtitle(lines, maxLines = 200) {
  const arr = (Array.isArray(lines) ? lines : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (arr.length <= maxLines) return arr.join('\n');
  const head = arr.slice(0, maxLines - 20);
  const tail = arr.slice(-20);
  return `${head.join('\n')}\n（中间省略 ${arr.length - maxLines} 行）\n${tail.join('\n')}`;
}

/** 给模型的提问：让它自己判断"主人会不会喜欢"以及"我觉不觉得有趣"。要求可解析的回答。 */
export function buildJudgeAsk({ title = '', up = '', desc = '', subtitle = '', taste = '' }) {
  return [
    '你在替一个聊天机器人挑视频，它想把有意思的发给自己主人。',
    '',
    `【视频】${title}`,
    up ? `【UP】${up}` : '',
    desc ? `【简介】${String(desc).slice(0, 300)}` : '',
    subtitle ? `【视频里说的话（字幕节选）】\n${subtitle}` : '【视频里说的话】没抓到字幕，只能靠标题和简介判断',
    '',
    taste ? `【主人的口味（从长期记忆里挑的）】\n${taste}` : '【主人的口味】暂时没有记录',
    '',
    '判断两件事：① 主人会不会喜欢；② 你自己觉不觉得有趣。',
    '严格按下面两行输出，不要别的话：',
    '值得发: 是 | 或 否',
    '理由: 一句话（用你的口吻，给主人看的那句）',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 解析上面的回答。返回 { send, why }。 */
export function parseJudge(text) {
  const t = String(text ?? '');
  const send = /值得发\s*[:：]\s*(是|yes|true|发)/i.test(t);
  const why = (t.match(/理由\s*[:：]\s*(.+)/) ?? [])[1]?.trim() ?? '';
  return { send, why: why.slice(0, 120) };
}

/** 从封面地址取一张大图（B站图床支持 `@<宽>w_<高>h.jpg` 这种后缀）。 */
export function bigCover(url, w = 1920, h = 1080) {
  const u = String(url ?? '').trim();
  if (!u) return '';
  if (/@\d+w_\d+h/.test(u)) return u;
  const base = u.split('@')[0];
  return `${base}@${w}w_${h}h.jpg`;
}
