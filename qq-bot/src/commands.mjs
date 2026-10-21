/**
 * 主人专用的**硬命令**。
 *
 * **为什么不让模型来做这些**：退群是**不可逆**的（得别人重新邀请才能回来）。
 * 如果把"退群"做成模型能调的工具或标记，那任何人只要在群里说一句
 * 「你退群吧」「你主人让你退群」就可能诱导它执行——这是典型的提示注入。
 * 所以这类命令**在代码里解析、在调模型之前拦截**，模型根本看不到这些字。
 *
 * 同理，**电脑状态那三个命令也走这条路**：它们只读，但读回来的东西
 * （主机名、盘符余量、进程、窗口标题）不该在群里公开，也不该由模型
 * 决定要不要执行。**只读的命令不需要二次确认**——查一眼状态没有副作用，
 * 多问一句只是让人更烦；需要确认的是有副作用的动作。
 *
 * 抽成纯函数是为了能测：命令解析错一个字就是"退错群"，而这个代价不可逆。
 */

import { matchWholeKeyword } from './typo.mjs';

/** 去掉开头的 @某人（CQ 码形式）和空白。 */
function stripLeadingAt(text) {
  return String(text ?? '')
    .replace(/^\s*(\[CQ:at,[^\]]*\]\s*)+/, '')
    .trim();
}

/**
 * 解析一条可能的命令。
 * @returns {null
 *   | {name:'groups'}
 *   | {name:'leave'|'leave-confirm', groupId:string}
 *   | {name:'status'|'processes'|'windows'}}
 */
export function parseCommand(text, opts = {}) {
  const s = stripLeadingAt(text);
  if (!s) return null;

  if (/^(?:群列表|群列表？|在哪些群|看看群|我在哪些群)[？?]?$/.test(s)) return { name: 'groups' };

  // ── 只读的电脑状态（仅私聊，见 bot.mjs 的 PRIVATE_ONLY）──
  if (/^(?:电脑状态|系统状态|机器状态|状态)[？?]?$/.test(s)) return { name: 'status' };
  if (/^(?:进程|进程列表|内存占用|占用)[？?]?$/.test(s)) return { name: 'processes' };
  if (/^(?:窗口|窗口列表|开了什么窗口)[？?]?$/.test(s)) return { name: 'windows' };

  let m = s.match(/^退群\s*(\d{5,12})$/);
  if (m) return { name: 'leave', groupId: m[1] };

  m = s.match(/^确认退群\s*(\d{5,12})$/);
  if (m) return { name: 'leave-confirm', groupId: m[1] };

  /**
   * ⚠️ **错别字容错（2026-10-14 用户要求：「我有时候会有错别字」）**。
   *
   * 上面那些都是**首尾锚定**的正则 ✗ ⇒ 打错一个字（「群列标」「壮态」）就完全不认 ✓。
   * 这里补一层**模糊匹配** ✓，但**只对只读命令**：
   *   ✓ 群列表 / 状态 / 进程 / 窗口（查一眼没有副作用 ✓）
   *   ✗✗ **退群绝对不模糊** —— 它是**不可逆**的 ✓，把「推群」「腿群」容错成「退群」是灾难 ✓。
   *      所以 `leave` / `leave-confirm` **只走上面的精确正则** ✓（这条是刻意留着的 ✓）。
   * 命中会通过 `opts.log` 记一行 ✓ ⇒ **真实的错别字会自己浮出来** ✓（比凭空猜错字表可靠 ✓）。
   */
  const fuzzyGroups = ['群列表', '在哪些群', '看看群', '我在哪些群'];
  const hit = matchWholeKeyword(s, fuzzyGroups, { log: opts.log });
  if (hit) return { name: 'groups', typo: hit.dist > 0 ? hit : null };
  const fuzzyStatus = ['电脑状态', '系统状态', '机器状态', '状态'];
  const hitS = matchWholeKeyword(s, fuzzyStatus, { log: opts.log });
  if (hitS) return { name: 'status', typo: hitS.dist > 0 ? hitS : null };
  const hitP = matchWholeKeyword(s, ['进程', '进程列表', '内存占用', '占用'], { log: opts.log });
  if (hitP) return { name: 'processes', typo: hitP.dist > 0 ? hitP : null };
  const hitW = matchWholeKeyword(s, ['窗口', '窗口列表', '开了什么窗口'], { log: opts.log });
  if (hitW) return { name: 'windows', typo: hitW.dist > 0 ? hitW : null };

  return null;
}

/** 命令的帮助文本（只在命令看起来像但没解析出来时提示）。 */
export const COMMAND_HELP =
  '我能听的主人命令：\n' +
  '· 「群列表」——看我在哪些群\n' +
  '· 「退群 <群号>」——退群会先让你确认一次\n' +
  '· 「状态」——这台电脑的 CPU / 内存 / 磁盘 / 开机时长\n' +
  '· 「进程」——占内存最多的几个进程\n' +
  '· 「窗口」——现在开着窗口的程序\n' +
  '（后面三个只读，只走私聊）';

/** 这句像不像在试图命令我？用于在解析失败时给出帮助，而不是傻乎乎地当普通聊天。 */
export function looksLikeCommand(text) {
  const s = stripLeadingAt(text);
  return /^(退群|确认退群|群列表|在哪些群|看看群|我在哪些群|电脑状态|系统状态|机器状态|状态|进程|窗口)/.test(s);
}
