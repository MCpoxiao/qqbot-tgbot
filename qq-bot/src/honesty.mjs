/**
 * 「嘴上说了、实际没做」的判据（谎话闸，2026-10-08 抽出来）。
 *
 * 为什么单独成模块：这类判断以前散在 `bot.mjs` 里（提醒一条、记忆一条），
 * 结果**新加的动作工具没人管** —— 实测就栽在这上面：
 * 用户说「你去给BV19rRFdEPk点个赞」，它**一次工具都没调**，
 * 回了「点完啦，赞已经在上面了」。账号动作**用户无法自证**
 * （他看不到日志），所以判据必须是**代码**、而且**能测**。
 *
 * 用法：`claimMismatch(reply, 这一轮真正调用过的工具名数组)` →
 * 返回"说了却没做"的条目列表；调用方据此**在回复末尾补一句实话**（不能只记日志）。
 */
const CLAIMS = [
  {
    re: /点[了个]?赞|赞已经|已点赞|取消[了]?赞|撤[了]?赞/,
    ask: /点赞|赞一下|点个赞|取消赞|撤回|撤销/,
    tools: ['bili_like'],
    label: '点赞/取消赞',
  },
  {
    // 判据（照"它会怎么说"写，不照我期望它怎么说 —— 今天在这上面栽过两次）：
    //   · 直接的完成claims：投了个币 / 投了两个币 / 已经投币 / 投币成功；
    //   · **当日汇总**那种：把「投币」列在一串里 + 后面跟"全给你安排上了/搞定"。
    //   ⚠️ 光有「投币」两个字**不算**（否则"投币可是花真硬币的，你要投吗"这种提问会被误判）。
    re: /投[了个一两二\d\s]+币|投币(?:成功|完成|已投)|已经投[了过]?币|(投币|三连)[^。！？]{0,30}(安排上|搞定|办好了|完成)/,
    ask: /投(?:了|个)*币|硬币/,
    topic: 'coin',
    tools: ['bili_coin'],
    label: '投币',
  },
  {
    re: /收藏(?:好|成|上|了)|已收藏|取消[了]?收藏/,
    ask: /收藏/,
    tools: ['bili_fav'],
    label: '收藏/取消收藏',
  },
  {
    re: /关注[了上]|已关注|取消[了]?关注|取关[了]?/,
    ask: /关注|取关/,
    tools: ['bili_follow', 'bili_confirm'],
    label: '关注/取关',
  },
  {
    // ⚠️ 不能要求回复里出现「说说」两个字：实测它说的是「**发了发了**…空间里现在挂着那条」——
    // 一个"说说"都没有，旧判据于是漏了。所以这里改成**认"发布了"这类断言**，
    // 靠下面的 `ask` 与 `topic` 两道闸防误报。
    re: /发了发了|已经发了|发出去了|发出去啦|发布成功|空间里.*(挂着|有了|在了)|(说说|空间)[^。！？]{0,12}(发了|发出|发好)/,
    ask: /说说|空间/,
    topic: 'qzone',
    tools: ['qzone_post', 'qq_confirm'],
    label: '发说说',
  },
  {
    // ⚠️ 同一个错犯了**第三遍**：「改好了」「挂在我主页上了」之后，这次它说的是「**好啦，改上去了！**」——
    //    「改上去」也不在旧词表里。**判据要认"这类断言"，不能只认我期望的那几个词。**
    // ⚠️ **第四次**补词：它说的是「**改完啦**」「真给你改上去了」—— 上一版只有「改完了」，
    //    「改完啦」又不匹配。这次把"完成"动词认全（改完/改好/改上/改到/换完/挂上/生效…），
    //    词尾 `[了啦吧哦]?` 统一放开；**宁可多报**（对"承诺将来做"的句子多补一句实话无害，
    //    漏掉"谎报已完成"才是真有害）。
    re: /(改完|改好|改成|改上|改到|换完|换好|换成|换掉|挂上|挂好|更新好|设置好|弄好|生效)[了啦吧哦]?|主页上[^。！？]{0,10}(挂着|显示|是)|(签名|昵称|头像)[^。！？]{0,8}(好了|变了|挂上)/,
    ask: /签名|昵称|头像|资料|个签/,
    topic: 'profile',
    tools: ['qq_profile_set', 'qq_avatar_set', 'qq_confirm'],
    label: '改资料/换头像',
  },
];

/**
 * @param {string} reply 模型这一轮**要发出去**的话
 * @param {Iterable<string>} ranNames 这一轮真正调用过的工具名
 * @param {{userText?:string, topic?:string}} [opts]
 *   · `userText`：多一道"用户那句话本身得像是在要求这件事"的闸（防闲聊误报）；
 *   · `topic`：**话题来自前几轮**时用它（实测踩过：用户说「可以，发吧」——
 *     句子里根本没有"说说/空间"，于是 `userText` 那道闸把真话放过了）。
 *     调用方从会话记忆里现算（比如"他 30 分钟内提过说说"），值域与 `label` 对应：`'qzone'`。
 * @returns {Array<{label:string, tools:string[]}>} 说了却没做的条目（空数组 = 没撒谎）
 */
/**
 * **凭空赖工具**（2026-10-10 实测）：用户发「帮我找洁哥的白丝图」，她两次回答
 * 「工具报了个错 / 工具那边直接崩了个错，图发不出来」—— 而那一轮 **0 次工具调用、0 条报错**。
 * 这类"把失败赖给工具"比"邀功"更难发现（它是**甩锅**），所以单独认。
 * 只在**真的一次工具都没调**时才算（调过但失败了，说报错是对的）。
 */
const TOOL_BLAME = /工具[^。！？]{0,12}(报错|报了个错|崩|失败|出问题|坏了)|(发|传)不出去|发送失败|传不上去/;

export function toolBlameMismatch(reply, ranNames) {
  if ([...(ranNames ?? [])].length > 0) return '';
  const m = String(reply ?? '').match(TOOL_BLAME);
  if (!m) return '';
  return `她说「${m[0]}」，但这一轮一次工具都没调 —— 那是编的，不是工具的问题`;
}

/**
 * **"嘴上操作了电脑"的断言**（2026-10-07 起就在 `bot.mjs` 里，2026-10-11 挪到这里并修了误报）。
 *
 * 用途：回复里说「截好了 / 发出去了 / 已经关了」这类**对电脑做了动作**的话，
 * 而这一轮**没有任何控制类工具调用** → 判定为"说做了其实没做"，补一句实话。
 *
 * ⚠️ **2026-10-11 用户报「谎话闸输出莫名其妙的」**，查出来就是这里的**误报**：
 * 她原话是「…怎么摸鱼摸到网上了，被我**抓到了**哦」——这里的"抓到了"是"抓到你了"，
 * 而旧判据里裸写的 `抓到了` 是为**截图**（抓到窗口）准备的。同一个词两种意思 → 误判成撒谎，
 * 于是后面补了一句「（说实话：这一轮我没真的做到，上面那句别信。）」，在闲聊里显得莫名其妙。
 *
 * 修法：**动作断言必须带上下文**（窗口/画面/截图/按钮…），不再认裸词。
 * 真实的那些句子仍然被抓住：「截好了」「我截了并发出去了」（有"发出去了"）「已经关了」。
 *
 * @returns {string} 命中的那句话（空串 = 没说这种话）
 */
export function controlActionClaim(reply) {
  const m = String(reply ?? '').match(ACTION_CLAIM);
  return m ? m[0] : '';
}

/**
 * ⚠️ 每一条都**要带上下文**，不许再写裸词（2026-10-11 的误报就是裸 `抓到了` 造成的）：
 *   · `截好了`/`截到图`/`截图了` —— 截图这件事本身说得够明确；
 *   · `(窗口|画面|屏幕)…截/抓到` —— 带对象的"抓到"；
 *   · `已经停了/关了/打开了/放起来了/按了/按过了` —— 明确说"已经做完某个操作"；
 *   · `按了/按过按钮` —— 带"按钮"；
 *   · `发出去了/发过去了` —— 说图/文件已经发出去。
 * 反面例子（**必须不命中**）：「被我抓到了哦」（抓到你了）、「我把这段话截给他看」（截给谁看）。
 */
const ACTION_CLAIM =
  /截好了|截到图|截图(?:了|好了|完成)|(?:窗口|画面|屏幕)[^。！？]{0,8}(?:截|抓)到|已经(?:停了|关了|打开了|放起来了|按了|按过了)|按(?:了|过)(?:那个)?按钮|发出去了|发过去了/;

export function claimMismatch(reply, ranNames = [], opts = {}) {
  const ran = ranNames instanceof Set ? ranNames : new Set(ranNames ?? []);
  const user = typeof opts.userText === 'string' ? opts.userText : null;
  const topic = String(opts.topic ?? '');
  const out = [];
  const text = String(reply ?? '');
  /**
   * **承诺闸**：动词前面紧挨着「就/再/等/马上/一会儿/待会」的，是"我**将要**做"而不是"我已经做了"。
   * 实测「草稿存好了，你说声**我就改上去**」——这种句子不该被判成撒谎（它没谎报完成）。
   * 只看动词前 8 个字，免得把「这回真给你改上去了」也误判。
   */
  const isPromise = (idx) => /[就再等][^。！？]{0,4}$|马上|一会儿|待会|让你|要我/.test(text.slice(Math.max(0, idx - 8), idx));
  for (const c of CLAIMS) {
    const m = c.re.exec(text);
    if (!m) continue;
    if (c.tools.some((t) => ran.has(t))) continue;
    if (isPromise(m.index)) continue;
    // 有用户原话时：**只有他确实要求了这件事**（或这个话题还在前几轮里热着），才算撒谎
    const askedHere = user !== null && c.ask ? c.ask.test(user) : true;
    const topicHot = topic && c.topic === topic;
    if (!askedHere && !topicHot) continue;
    out.push({ label: c.label, tools: c.tools, at: m.index });
  }
  return out;
}

/**
 * 从**它自己上一轮那段话**里把它提议的草稿抠出来（引号里的那一句）。
 *
 * 为什么要这个：实测它会在对话里"拟一版"给你看（「…」包起来），你回「可以，发吧」，
 * 它**从头到尾没调过任何工具**，于是草稿从来没进过代码的手里 —— 一approve 就只能靠它自觉。
 * 有了这个函数，approve 那一步就能**代码自己**把上一轮的草稿捡起来、存成草稿、再发出去。
 *
 * 认这几种写法（按优先级）：`「…」`、`“…”`、`【…】`、`草稿：…`。
 * @returns {string} 抠出来的正文；认不出给空串（调用方据此明确说"我没看清你要发哪句"）
 */
export function extractDraft(text) {
  const t = String(text ?? '');
  const quoted = [...t.matchAll(/[「『]([^」』]{2,500})[」』]/g)].map((m) => m[1].trim()).filter(Boolean);
  if (quoted.length) return quoted[quoted.length - 1]; // 取**最后**一处引用（他可能先举例再给草稿）
  const smart = [...t.matchAll(/[“"]([^”"]{2,500})[”"]/g)].map((m) => m[1].trim()).filter(Boolean);
  if (smart.length) return smart[smart.length - 1];
  const bracket = [...t.matchAll(/【([^】]{2,500})】/g)].map((m) => m[1].trim()).filter(Boolean);
  if (bracket.length) return bracket[bracket.length - 1];
  const labeled = t.match(/草稿\s*[:：]\s*([^\n]{2,500})/);
  return labeled ? labeled[1].trim() : '';
}

/**
 * 从一句话里判断：**她想改的是「昵称」还是「签名」**，正文分别是什么。
 *
 * 为什么非分不可（2026-10-09 实测的 bug）：用户说「再改一次吧**昵称**」，
 * 而我的批准路径**不管三七二十一把正文写进 `personal_note`** ——
 * 结果**签名被改成了「小笛」**，昵称一个字没动。用户的原话就是「改签名还是有点bug」。
 *
 * 认法：关键词（昵称/名字/签名/个签…）后面 60 字内**第一处**引号内容；
 * 没有引号就认「改成/换成/改为/设为/为/是」后面那个词。
 * 两个字段都认得出（他要一次改俩）就都返回；认不出给空串，由调用方决定是问他、还是按用户那句话判。
 *
 * @returns {{nickname: string, personal_note: string}}
 */
export function parseProfileProposal(text) {
  const s = String(text ?? '');
  /** 关键词后面那一段里**第一处**引号内容（注意不能用 extractDraft：它取的是"最后"一处，
   *  一句里同时提到昵称和签名时会取错）。 */
  const firstQuote = (t) => t.match(/[「『“"【]([^」』”"】\n]{1,80})[」』”"】]/)?.[1]?.trim() ?? '';
  const grabNear = (re, maxLen) => {
    const m = re.exec(s);
    if (!m) return '';
    const tail = s.slice(m.index, m.index + 60);
    const q = firstQuote(tail);
    if (q) return q.slice(0, maxLen);
    // 没引号：「改成 X」这种
    const t = tail.match(/(?:改成|换成|改为|设为|变成|是|为)\s*[:：]?\s*([^\s，。！？、,.!?]{1,80})/);
    return t ? t[1].trim().slice(0, maxLen) : '';
  };
  return {
    nickname: grabNear(/(?:昵称|QQ\s*名|名字|改名叫)/, 24),
    personal_note: grabNear(/(?:个性签名|签名档|个人签名|个签|签名)/, 80),
  };
}

/** 补在回复末尾的那句实话（语气别自我贬低 —— 只陈述事实，见 bot.mjs 里那段说明）。 */
export function honestNote(label) {  return `\n\n（说实话：这一轮我没真的${label}，上面那句别信 —— 账号那边什么都没发生。）`;
}
