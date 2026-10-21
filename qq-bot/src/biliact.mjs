/**
 * B站 侧的**动作**（点赞 / 投币 / 收藏 / 关注）—— 2026-10-08 交接第 ⑥ 条。
 *
 * 与 `qqact.mjs` 同一套纪律（那边管 QQ 账号，这边管 B站 账号）：
 *   1. **闸在执行层**：每个动作执行前重判「私聊 + 主人 + 总开关」，`ctx` 由 bot.mjs 现算；
 *   2. **群里连工具定义都看不到**（`toolsForContext` 只在私聊主人时注入）；
 *   3. **每件事都写审计**（`logs/bili-act.log`，JSONL 只追加）——它同时是**频率计数**的来源。
 *
 * 审不审，按用户定的总原则（对外新增/改变要审，收回/撤销免审）：
 *   · **赞 / 投币 / 收藏**：免审 —— 但都带**每日上限**；**投币要花硬币**，上限最紧（默认 5）；
 *   · **关注**：**要审**（先存草稿 → 主人点头 → 才关注）；**取关免审**（那是"收回"）。
 *
 * ⚠️ **写接口必须有 `bili_jct`（csrf）**：没填时不做任何请求，直接明确告诉他
 *   「面板「B站登录」第二个框填一下」——而不是让 B站 回一个含糊的 -111 让人以为被风控了。
 */
import { resolve } from 'node:path';
import { ROOT } from './config.mjs';
import { getJsonAuthed, postForm, resolveBvid, videoInfoRaw } from './bilibili.mjs';
import { appendAct, checkQuota, clearDraft, getDraft, readActs, setDraft } from './qqact.mjs';

const API = {
  like: 'https://api.bilibili.com/x/web-interface/archive/like',
  coin: 'https://api.bilibili.com/x/web-interface/coin/add',
  favDeal: 'https://api.bilibili.com/x/v3/fav/resource/deal',
  favFolders: 'https://api.bilibili.com/x/v3/fav/folder/created/list-all',
  relation: 'https://api.bilibili.com/x/relation/modify',
  nav: 'https://api.bilibili.com/x/web-interface/nav',
};

export function biliActLogFile(cfg) {
  return resolve(ROOT, String(cfg?.biliAct?.logFile ?? 'logs/bili-act.log'));
}

export function biliActEnabled(cfg) {
  return cfg?.biliAct?.enabled !== false;
}

/** 唯一的准入判断（fail-closed）。 */
export function biliActAllowed(cfg, ctx) {
  if (!biliActEnabled(cfg)) return false;
  if (!ctx || typeof ctx !== 'object') return false;
  if (ctx.isPrivate !== true) return false;
  if (ctx.isMaster !== true) return false;
  return true;
}

export const BILIACT_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'bili_like',
      description:
        '给 B站 视频点赞 / 取消赞（**不需要审批**）。取消赞传 undo=true —— 撤回算"收回"，同样不用问。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV 号' },
          undo: { type: 'boolean', description: 'true = 取消赞' },
        },
        required: ['bvid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bili_coin',
      description:
        '给 B站 视频投币（**不需要审批**，但**要花硬币**，所以有每日上限）。count 只能 1 或 2。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV 号' },
          count: { type: 'integer', description: '投几个币，1 或 2（默认 1）', minimum: 1, maximum: 2 },
        },
        required: ['bvid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bili_fav',
      description: '把 B站 视频收藏进**默认收藏夹**（**不需要审批**）。取消收藏传 undo=true —— 同样是"收回"，免审。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV 号' },
          undo: { type: 'boolean', description: 'true = 取消收藏' },
        },
        required: ['bvid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bili_follow',
      description:
        '关注某个 UP（**要审批**：先存草稿，主人点头后你再调 `bili_confirm`）。取关传 undo=true —— **免审**。',
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'UP 的 UID（数字）' },
          undo: { type: 'boolean', description: 'true = 取关' },
        },
        required: ['uid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bili_confirm',
      description: '主人点头之后，把**待审的 B站 动作**（关注）真的做掉。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export const BILIACT_TOOL_NAMES = new Set(BILIACT_TOOL_DEFS.map((d) => d.function.name));

/** 把 B站 的返回码翻成人话（这几种最常撞上，其它的原样带出来）。 */
export function explainCode(code, message) {
  const map = {
    0: '成功',
    '-101': '账号未登录（SESSDATA 可能失效了）',
    '-111': 'csrf 校验失败（`bili_jct` 不对或过期了）',
    '-400': '请求参数不对',
    '-403': '访问权限不足（可能要大会员 / 或风控）',
    '-404': '找不到这个视频/用户',
    '65006': '已经收藏过了',
    '34005': '已经投过币了（同一个视频最多两个）',
    '-509': '请求过于频繁，歇一会儿',
    '22001': '不能关注自己',
  };
  const key = String(code);
  const human = map[key] ?? '';
  return `${human ? `${human} ` : ''}（code=${key}${message ? ` ${message}` : ''}）`.trim();
}

/**
 * 执行一次 B站 动作工具。**永远返回字符串**，永远不抛。
 *
 * @param cfg 配置（热重载的同一个对象）
 * @param ctx { isPrivate, isMaster, who, biliPost?, biliGet? }
 *   `biliPost` / `biliGet` 是**给自测注入替身用的**；生产里不传，用真实实现。
 */
export async function runBiliActTool(cfg, name, args = {}, ctx = null) {
  const LOG = biliActLogFile(cfg);
  if (!BILIACT_TOOL_NAMES.has(name)) return `错误：没有叫 ${name} 的 B站 工具。`;
  if (!biliActAllowed(cfg, ctx)) {
    appendAct({ action: name, ok: false, note: '拒绝：非主人私聊', args: args ?? {} }, LOG);
    return '这个只能在主人的私聊里用（B站 那边也只在他面前动）。';
  }
  const a = args ?? {};
  const post = typeof ctx?.biliPost === 'function' ? ctx.biliPost : postForm;
  const get = typeof ctx?.biliGet === 'function' ? ctx.biliGet : getJsonAuthed;
  const view = typeof ctx?.biliView === 'function' ? ctx.biliView : videoInfoRaw; // 自测可替身，免打网络
  const who = String(ctx?.who ?? '');
  const acts = readActs(LOG);

  /** 统一的一次写操作：查上限 → 调接口 → 记审计。 */
  const write = async ({ action, cap, params, api, field, extra = {} }) => {
    const q = checkQuota(cfg, readActs(LOG), action, Date.now(), 'biliAct');
    if (!q.ok) return { ok: false, why: `今天${field}得够多了 —— ${q.why}` };
    let r;
    try {
      r = await post(api, params);
    } catch (err) {
      appendAct({ action, ok: false, why: err.message, params }, LOG);
      return { ok: false, why: `${field}失败了：${err.message}` };
    }
    if (r?.code !== 0) {
      appendAct({ action, ok: false, code: r?.code, message: r?.message, params }, LOG);
      return { ok: false, why: `${field}没成：${explainCode(r?.code, r?.message)}` };
    }
    appendAct({ action, ok: true, params, ...extra }, LOG);
    return { ok: true };
  };

  switch (name) {
    case 'bili_like': {
      const bv = (await resolveBvid(a.bvid)) ?? '';
      if (!bv) return '认不出视频号（给我 BV 号或视频链接）。';
      const undo = a.undo === true;
      const res = await write({
        action: undo ? 'unlike' : 'like',
        api: API.like,
        field: undo ? '取消赞' : '点赞',
        params: { bvid: bv, like: undo ? 2 : 1 },
      });
      // 取消赞不该被"点赞上限"卡住：上限只算 like
      return res.ok ? (undo ? `取消赞了（${bv}）。` : `点赞了（${bv}）。`) : res.why;
    }

    case 'bili_coin': {
      const bv = (await resolveBvid(a.bvid)) ?? '';
      if (!bv) return '认不出视频号（给我 BV 号或视频链接）。';
      const n = Math.min(2, Math.max(1, Number(a.count) || 1));
      const res = await write({
        action: 'coin',
        api: API.coin,
        field: '投币',
        params: { bvid: bv, multiply: n, select_like: 1 },
      });
      return res.ok ? `投了 ${n} 个币（${bv}），顺手也点了赞。` : res.why;
    }

    case 'bili_fav': {
      const info = await view({ bvid: a.bvid });
      if (!info) return '认不出视频号，或者取详情失败了。';
      if (!info.aid) return '没拿到这个视频的 aid（收藏接口要它）。';
      const undo = a.undo === true;
      let folderId = null;
      try {
        const nav = await get(API.nav);
        const mid = nav?.data?.mid;
        if (mid) {
          const list = await get(`${API.favFolders}?up_mid=${mid}`);
          folderId = list?.data?.list?.[0]?.id ?? null;
        }
      } catch {
        /* 取不到收藏夹就按"默认收藏夹"参数留空，让接口自己挑 */
      }
      const res = await write({
        action: undo ? 'unfav' : 'fav',
        api: API.favDeal,
        field: undo ? '取消收藏' : '收藏',
        params: undo
          ? { rid: info.aid, type: 2, add_media_ids: '', del_media_ids: folderId ?? '' }
          : { rid: info.aid, type: 2, add_media_ids: folderId ?? '', del_media_ids: '' },
        extra: { title: info.title.slice(0, 60) },
      });
      if (!res.ok) return res.why;
      return undo
        ? `从收藏夹里拿掉了「${info.title.slice(0, 30)}」${folderId ? '' : '（没查到收藏夹 id，可能没删掉，你确认一下）'}。`
        : `收藏了「${info.title.slice(0, 30)}」${folderId ? '' : '（默认收藏夹）'}。`;
    }

    case 'bili_follow': {
      const uid = String(a.uid ?? '').trim();
      if (!/^\d{1,12}$/.test(uid)) return 'UP 的 UID 是一串数字，给我数字。';
      if (a.undo === true) {
        // **取关免审**（"收回"不算对外新增）
        const res = await write({
          action: 'unfollow',
          api: API.relation,
          field: '取关',
          params: { fid: uid, act: 2, re_src: 11 },
        });
        return res.ok ? `取关了（uid ${uid}）。` : res.why;
      }
      setDraft(who, 'follow', { uid }, `关注 uid ${uid}`);
      appendAct({ action: 'draft', kind: 'follow', ok: true, params: { uid } }, LOG);
      return `草稿存下了（关注 uid ${uid}）。**先问主人要不要关注**，他点头之后再调 \`bili_confirm\`。`;
    }

    case 'bili_confirm': {
      // ⚠️ 同 qq_confirm：**点头只能来自主人那句话**，不然模型能自己批准自己（2026-10-09 补）
      if (ctx?.userApproved !== true) {
        appendAct({ action: name, ok: false, note: '拒绝：没有主人的点头（模型不能自己批准自己）' }, LOG);
        return '这一步要**主人点头**才能做 —— 只认他说的「可以 / 行 / 就这个」，我自己说"确认"不算。先问他要不要关注。';
      }
      const d = getDraft(who);
      if (!d) return '现在没有待办的 B站 动作（草稿没存过或已作废）。';
      if (d.kind !== 'follow') return '待办的不是 B站 的事（QQ 那边的草稿请用 qq_confirm）。';
      const res = await write({
        action: 'follow',
        api: API.relation,
        field: '关注',
        params: { fid: d.args.uid, act: 1, re_src: 11 },
      });
      if (!res.ok) {
        clearDraft(who);
        return `${res.why}（这条草稿作废了）`;
      }
      clearDraft(who);
      return `关注了（uid ${d.args.uid}）。`;
    }

    default:
      return `没有叫 ${name} 的 B站 工具。`;
  }
}
