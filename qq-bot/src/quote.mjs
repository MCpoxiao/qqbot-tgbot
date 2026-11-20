/**
 * **引用回复的"上下文备注"**（2026-11-20 抽出成纯函数）。
 *
 * 为什么抽出来：这段逻辑原来直接写在 `bot.mjs` 的消息主循环里 ✗ —— 结果 2026-11-01 出了个
 * 很难看见的 bug：`if (quotedNote) textForModel += quotedNote;` 被写在 `if (images.length)` **里面** ✗
 * ⇒ **纯文字引用永远不生效** ✓（用户引用一条 150 字的消息说「记」，她回「没看着你要记的东西」✗）。
 * 抽成纯函数后可以**单测** ✓；那行"拼进去"的语句另外用**缩进守卫**盯着 ✓（见自测）。
 *
 * 口径（2026-10-10 定下的）：
 * · 私聊里非我发的 = **他**（正在跟你说话这个人）✓；群里才叫**别人** ✓；
 * · 别提"他在问你那句话"✗ —— 他是在说**那条消息里的内容** ✓；
 * · 被引用的是我自己发的 → 明说"那条是**你自己**发的" ✓；
 * · 被引用的那条里有链接 → 单独点出来 ✓。
 */

/**
 * @param {{ qText?: string, qMine?: boolean, isPrivate?: boolean, maxChars?: number }} args
 * @returns {string} 要拼进模型上下文的备注（没有文字就返回空串 ✓）
 */
export function buildQuotedNote({ qText = '', qMine = false, isPrivate = false, maxChars = 200 } = {}) {
  const text = String(qText ?? '').trim();
  if (!text) return '';
  const who = qMine ? '你自己' : isPrivate ? '他' : '别人';
  const mineOrHim = qMine || who === '他';
  const link = /https?:\/\//.test(text) ? (text.match(/https?:\/\/\S+/) ?? [''])[0].slice(0, 120) : '';
  return (
    `\n【他引用的那条消息是**${who}**之前说的】` +
    text.slice(0, Math.max(1, Number(maxChars) || 200)) +
    (mineOrHim
      ? '\n（他这句话是在说那条消息里的**内容**（比如里面的视频、图、或者那件事）——' +
        '别当成他在问你那句话本身，也不是别人发来的半句。**那条是' +
        (qMine ? '你自己' : '他') +
        '发的，你得认得。**' +
        (link ? '\n那条里有链接：' + link : '') +
        '）'
      : '')
  );
}
