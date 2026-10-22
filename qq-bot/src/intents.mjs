/**
 * 确定性意图路由 —— 「说清楚了的动作，由代码先做，不等模型决定」。
 *
 * ## 为什么要有它
 *
 * 2026-10-07 一天里两次真实翻车：
 *   · 13:38「帮我把歌曲暂停一下」→ 模型**根本没调工具**，直接回了句「停了。」
 *   · 13:39「把dsh的窗口截图发我」→ 也没调，还**编了一句工具失败原因**（装得跟真的一样）
 *
 * 只靠提示词写「你必须调工具」治不了这个 —— 这个项目已经反复验证过那条路。
 * 所以：主人私聊里命中**明确动作**时，**代码直接调对应能力**，把真实结果塞回上下文，
 * 让模型只负责"把已经发生的事说人话"。
 *
 * 而且这一轮要**把控制类工具从它的工具表里拿掉** —— `play_pause` 是**开关**，
 * 被按两次等于什么都没做（甚至又切回去）。代码已经做了，就别让它再摸一遍。
 *
 * ## 边界（重要）
 *
 * 只认**参数明确**的动作。像「把那个窗口截图发我」这种需要**理解目标**的，不在这里 ——
 * 目标提取是真需要句意理解的，交给模型；它要是又不调工具、只在嘴上编，
 * 由另一道「谎话闸」兜（见 bot.mjs 里的 warn）。
 */
const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 中文数字 → 数字（只覆盖常用说法：三、十、十五、二十、半）。认不出返回 NaN。 */
function cnNumber(tok) {
  const t = String(tok ?? '').trim();
  if (!t) return NaN;
  if (/^\d+$/.test(t)) return Number(t);
  if (t === '半') return 0.5;
  if (t.length === 1) return CN_NUM[t] ?? NaN;
  if (t.startsWith('十')) return 10 + (CN_NUM[t[1]] ?? 0);
  if (t.endsWith('十')) return (CN_NUM[t[0]] ?? 1) * 10;
  if (t.length === 2 && CN_NUM[t[0]] != null && CN_NUM[t[1]] != null) return CN_NUM[t[0]] * 10 + CN_NUM[t[1]];
  return NaN;
}

function matchIntentLines(raw, { refs = null, pending = '' } = {}) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 60) return null; // 长句子多半在讲事情，不是在下命令

  // ── 账号自理的「确认」：有草稿（她刚要发说说/改资料）+ 主人明确点头 → **代码直接执行** ──
  // 为什么要代码接管：这正是"模型嘴上说发了、其实没调工具"的老毛病（见 memory/lessons.md 的谎话闸）。
  // 草稿是**我们自己存下的**，所以"他说的是不是同意"这件事可以判得很确定 —— 不必再问模型。
  // （`pending` 由 bot.mjs 从 qqact 的草稿状态里现算传进来；本模块**保持纯函数**，不 import 任何东西。）
  /**
   * ⚠️ **2026-10-22 真机事故**：确认词里原来有 **`行|好|嗯`** ✗ ——
   *    一个「发说说」的草稿挂了半个多小时（而它没有超时机制 ✗），
   *    用户随口回了一个「**嗯**」（日常应答 ✓），被这句规则当成**确认**✗ ⇒
   *    代码去执行 `qq_confirm`，结果"没认出要发哪句"⇒ 她回了
   *    「刚才不是说发说说的事嘛，我这边没认出你要发的是哪一句」✗ —— 用户看到的就是"「嗯」被映射走了"✗。
   *
   * 修法：**去掉 `行 / 好 / 嗯`** ✓ —— 确认必须是**明确表态**（发 / 发吧 / 确认 / 同意 …）✓。
   * 闲聊里的一句「嗯」永远只是「嗯」✓。
   */
  if (pending && /^(?:发|发吧|发出去|发这条|就这么发|可以发|同意|确认|改吧|换吧|退回去)[。！!~～\s]*$/.test(s)) {
    // 待审的是哪一边，就交给哪一边的确认工具：B站 关注走 `bili_confirm`，QQ 那几件走 `qq_confirm`
    return { tool: pending === 'follow' ? 'bili_confirm' : 'qq_confirm', args: {}, label: '把待审的那件事做掉' };
  }

  /**
   * **「是《X》的歌词」= 他在纠正歌名**（2026-10-22 加）：
   * 真机：她接歌接成了《东南苦山行》，用户回「是东行苦南山的歌词」✓ ——
   * 这句原来落到模型手里 ✗，它既不知道要重查、又容易跟别的话题串味 ✓。
   * 现在直接交 `lyrics({action:'search'})` ✓：按他给的歌名重新找候选版本 ✓，再由她挑对的那版接 ✓。
   */
  const songFix = s.match(/^(?:是|就是|应该是|应该是)?\s*[《「“]?([^《》「」“”\n]{2,20}?)[》」”]?\s*(?:这首歌)?的?歌词[。！!~～\s]*$/);
  if (songFix && !/什么|怎样|怎么|哪首/.test(songFix[1])) {
    return { tool: 'lyrics', args: { song: songFix[1].trim(), action: 'search' }, label: '按他说的歌名重查歌词' };
  }

  // ── 她自己的账号 / B站 动作：**说清楚了的动作由代码先做** ──
  //   为什么非接管不可（2026-10-08 实测）：用户说「你去给BV19rRFdEPk点个赞」，
  //   它**一次工具都没调**，却回了「点完啦，赞已经在上面了」。
  //   （⚠️ 更正：那个少一个字母的 BV 号是**用户自己打错的**，它只是照抄 —— 别把它算成"它编的"。）
  //   账号动作**用户无法自证**（他看不到我的日志），所以不能只靠模型自觉。
  //
  // ⚠️ 分界（照用户定的规矩）：
  //   · **免审且可逆的**（赞/取消赞/收藏/取消收藏/取关）→ 代码**直接执行**；
  //   · **要审的**（关注 / 发说说）→ 代码只**建草稿**，真正执行仍要主人点头；
  //   · **花钱的（投币）不接管** —— 宁可让它问一句，也不因为一句口语把硬币花出去。
  const bvHit = s.match(/BV[0-9A-Za-z]{8,14}/)?.[0] ?? '';
  // 外层 guard 要**认全口语说法**：「投币」「投个币」「投两个币」「硬币」都算（写窄了就会漏，今天犯过两次）
  if (bvHit && /(点赞|赞一下|点个赞|点一下|点这个|收藏|三连|取消赞|撤.{0,2}赞|撤回|撤销|撤了|投\s*[一两二三四\d]?\s*个?\s*币|硬币)/.test(s)) {
    // ⚠️ **否定的句子不能接管**（"别投币""不用点赞"）—— 花钱/写状态的事尤其怕这个。
    //    间隙要放宽：他可能说「不给BV19rRFBdEPk投币」，中间隔着整个 BV 号。
    const negated = /(不|别|不用|不要|算了)[^。！？]{0,24}(投\s*[一两二三四\d]?\s*个?\s*币|投币|硬币|点赞|收藏)/.test(s);
    if (/(取消收藏|不收藏了|收藏.{0,6}(撤回|撤销|撤了)|(撤回|撤销|撤了).{0,6}收藏)/.test(s) && !negated) {
      return { tool: 'bili_fav', args: { bvid: bvHit, undo: true }, label: `取消收藏 ${bvHit}` };
    }
    if (/(取消赞|撤.{0,2}赞|不赞了|收回.{0,2}赞|撤回|撤销|撤了)/.test(s) && !negated) {
      // ⚠️ 用户原话就是这种：「点BV19rRFBdEPk这个，**刚刚的撤回**」——
      // 一句里既有新目标又有撤回，按"撤回上一个、操作这一个"理解（这正是他要的）。
      return { tool: 'bili_like', args: { bvid: bvHit, undo: true }, label: `取消赞 ${bvHit}` };
    }
    /**
     * 投币：**代码接管，但只由代码执行**（2026-10-08 用户明确要求"把投币也修一下"）。
     * 为什么原来不接管：它花的是**真硬币**、不可逆 —— 我当时的判断是"宁可让模型问一句"。
     * 实测结果：模型照样会**嘴上报"投了"**（谎话闸抓到两条 warn），而硬币一个没动
     * —— 也就是"不接管"并没有换来安全，只换来了不可信。
     * 所以现在接管，并靠三件事兜底：**必须带 BV**、**必须不是否定句**、
     * **每日上限**（`biliAct.maxCoinPerDay`，默认 5）＋**每次最多 2 个**（B站 的硬限制）。
     */
    if (/(投\s*[一两二三四\d]?\s*个?\s*币|硬币)/.test(s) && !negated) {
      const cn = { 一: 1, 二: 2, 两: 2, 三: 2, 四: 2 }; // B站 单次最多 2 个，多于 2 按 2 处理
      const m = s.match(/投\s*([一两二三四]|\d{1,2})\s*个?\s*币/);
      const count = m ? (/^\d+$/.test(m[1]) ? Number(m[1]) : (cn[m[1]] ?? 1)) : 1;
      const n = Math.min(2, Math.max(1, count));
      return { tool: 'bili_coin', args: { bvid: bvHit, count: n }, label: `给 ${bvHit} 投 ${n} 个币` };
    }
    if (negated) return null;
    if (/收藏/.test(s)) return { tool: 'bili_fav', args: { bvid: bvHit }, label: `收藏 ${bvHit}` };
    return { tool: 'bili_like', args: { bvid: bvHit }, label: `给 ${bvHit} 点赞` };
  }

  // 关注 / 取关：**有 uid 才算数**（免得把随口一句"关注"当成指令）
  const uidHit = s.match(/(?:uid|UID|用户|up主?|up)\D{0,6}(\d{4,12})/)?.[1] ?? '';
  if (uidHit && /(关注|取关|取消关注)/.test(s)) {
    const undo = /(取关|取消关注)/.test(s);
    return { tool: 'bili_follow', args: { uid: uidHit, undo }, label: `${undo ? '取关' : '关注'} uid ${uidHit}` };
  }

  // 发说说：只建草稿（内容要能看出来是正文，免得把"说说"两个字本身当成内容）
  const qzHit = s.match(/(?:发|发个|发一条|发条|来条)\s*(?:说说|QQ\s*空间|空间)\s*[:：,，]?\s*(.{2,200})$/);
  if (qzHit) {
    return { tool: 'qzone_post', args: { content: qzHit[1].trim() }, label: '发说说的草稿' };
  }
  const media = /(音乐|歌曲|歌|视频|播放器|媒体|QQ音乐|放着的|正在放)/i.test(s);
  const recentMedia = Boolean(refs?.lastMedia && Date.now() - refs.lastMedia < 5 * 60 * 1000);

  // ── 音量（带数字的最明确）──
  const num = s.match(/音量[^0-9]{0,6}(\d{1,3})/);
  if (num) {
    const v = Number(num[1]);
    if (v >= 0 && v <= 100) return { tool: 'volume', args: { level: v }, label: `把音量调到 ${v}%` };
  }
  // ⚠️ 顺序要紧：「取消静音」里也含「静音」两个字，必须**先判取消**
  if (/(取消静音|解除静音|开声音|恢复声音|把声音打开)/.test(s)) return { tool: 'volume', args: { mute: false }, label: '取消静音' };
  if (/(静音|别出声|别出声音)/.test(s)) return { tool: 'volume', args: { mute: true }, label: '静音' };
  if (/(声音|音量)[^。！？]{0,4}(小|低|轻)/.test(s)) return { tool: 'volume', args: { delta: -10 }, label: '把音量调低 10%' };
  if (/(声音|音量)[^。！？]{0,4}(大|高)/.test(s)) return { tool: 'volume', args: { delta: 10 }, label: '把音量调高 10%' };

  // ── 媒体控制 ──
  if (/(下一首|下一个|切歌|换一首|换歌)/.test(s)) return { tool: 'media_control', args: { action: 'next' }, label: '切下一首' };
  if (/(上一首|前一首|退回一首)/.test(s)) return { tool: 'media_control', args: { action: 'prev' }, label: '切上一首' };
  if (/(停止播放|别放了|把音乐关|关掉音乐)/.test(s)) return { tool: 'media_control', args: { action: 'stop' }, label: '停止播放' };
  // 刻意**不收**「停了」这种叙述句（"音乐停了" 是陈述，不是命令）
  const actionish = /(暂停|停一下|继续|接着放|恢复播放|放起来)/.test(s);
  /**
   * **口语短句也要认。** 2026-10-07 真实漏网：用户发「在暂停一下呗」，
   * 我这条规则只认「^(帮我)?暂停…」，于是它掉到模型那边 —— 模型又在嘴上说了句「停了」。
   * 判据改成：**把语气词/填充词去掉之后，剩下的是不是就是那个动作**（而且整句很短）。
   */
  const cleaned = s.replace(
    /(在|再|帮我|给我|麻烦|请|先|快|把|将|它|这个|那个|一下|下|个|了|的|吧|呗|啊|呀|么|呢|~|～|，|。|！|？|!|\?|,|\s)/g,
    '',
  );
  const short = cleaned.length <= 5;
  // 「停」要**开头就是动词**才认 —— 否则「我停车去了」也会被当成暂停
  if (short && /^(暂停|停)/.test(cleaned)) {
    return { tool: 'media_control', args: { action: 'play_pause', want: 'pause' }, label: '暂停' };
  }
  /**
   * 「放」这一类要更小心：「打开」既可能是"放歌"也可能是"开程序"。
   * 判据：① 句子里有媒体词，或 ② **刚才 5 分钟内**刚操作过媒体（指代），
   * 并且 ③ 句子里没有程序名（微信/浏览器/steam…）。
   * 2026-10-07 真实漏网：用户刚暂停完说「再打开」——没认出来，模型就编了句"脚本失败"。
   */
  const appish = /(微信|qq|steam|浏览器|记事本|word|excel|终端|文件夹|设置)/i.test(s);
  const openish = /^(打开|再来|重新放|再放)/.test(cleaned) && cleaned.length <= 5 && !appish && (media || recentMedia);
  /**
   * ⚠️ **2026-10-20 真机 bug**：用户正在让她操作手机（领签到、进编队），他回了一句「**继续啊**」✗
   *   ⇒ 被这条规则抓成 `media_control` ✗ ⇒ **代码层直接执行**，去按了电脑的**播放/暂停**键 ✗，
   *   手机那条任务**整个丢掉** ✓ —— 用户看到的就是「她卡着不动了」✗。
   *   修法：**光说「继续 / 接着」不算数** ✓ —— 必须有媒体词，或 5 分钟内刚操作过媒体（指代）✓。
   *   「接着放 / 继续放 / 恢复播放 / 放起来 / 播放」自带「放」字，仍然照旧认 ✓。
   */
  const explicitPlay = /^(接着放|继续放|恢复播放|放起来|播放|放)/.test(cleaned);
  const bareContinue = /^(继续|接着|继续吧|接着来)/.test(cleaned);
  if (short && (explicitPlay || (bareContinue && (media || recentMedia)) || openish)) {
    return { tool: 'media_control', args: { action: 'play_pause', want: 'play' }, label: '继续播放' };
  }
  if (actionish && media) {
    return { tool: 'media_control', args: { action: 'play_pause' }, label: '播放/暂停' };
  }

  // ── 定时提醒：**代码直接设**，别指望模型去调 set_reminder ──
  // 2026-10-07 实测：同一件事交给模型就是抽奖 —— 15:08 那次它调了 set_reminder，
  // 15:22「提醒我一分钟后喝水」它**没调**，却回了「设好了」；用户等到的是"根本不提醒"。
  // 参数明确（有相对分钟数，或带上午/下午/冒号的钟点）就直接落库，模型只负责复述。
  if (/(提醒我|叫我|喊我)/.test(s)) {
    const rel = s.match(/(\d+|[一二两三四五六七八九十半]+)\s*(?:个)?\s*(分钟|分|小时|钟头|钟)\s*(?:后|以后|之后)/);
    const abs = s.match(/(上午|下午|晚上|中午|凌晨)?\s*([零一二两三四五六七八九十\d]{1,3})\s*[点:：]\s*([零一二三四五六七八九十\d]{0,2})/);
    let afterMinutes;
    let at;
    if (rel) {
      const n = cnNumber(rel[1]);
      // ⚠️ 必须**精确匹配**小时单位：`/钟/.test('分钟')` 也是 true —— 我第一版就这么写的，
      // 于是「一分钟后」被算成 **60 分钟**、两分钟后算成 120 分钟（自测当场抓住）。
      const isHour = /^(?:小时|钟头|钟)$/.test(rel[2]);
      if (n > 0) afterMinutes = isHour ? Math.round(n * 60) : Math.round(n);
    } else if (abs && (abs[1] || /[:：]/.test(abs[0]))) {
      // 只有**带上午/下午**、或**带冒号**的写法才敢自己换算 ——「十点」到底是上午还是晚上，交给模型问
      const h0 = cnNumber(abs[2]);
      const m0 = abs[3] ? cnNumber(abs[3]) : 0;
      if (h0 >= 0 && h0 <= 23 && m0 >= 0 && m0 <= 59) {
        const h = /下午|晚上|中午/.test(abs[1] ?? '') && h0 < 12 ? h0 + 12 : h0;
        at = `${String(h).padStart(2, '0')}:${String(m0).padStart(2, '0')}`;
      }
    }
    if (afterMinutes || at) {
      // 要提醒的"内容"：把时间短语和动词抠掉，剩下的就是
      const text = s
        .replace(rel?.[0] ?? '', '')
        .replace(abs?.[0] ?? '', '')
        .replace(/^(?:帮我|给我|你|麻烦|请|要|去|记得)+/g, '')
        .replace(/(?:提醒我|叫我|喊我|提醒一下|提醒|记得|一声|一下)/g, '')
        .replace(/^[的，,。、\s]+/, '')
        .trim();
      const finalText = text || '到点啦，你让我提醒你的那件事';
      /**
       * ⚠️ 参数名是 **`after_minutes`（下划线）**，不是 `afterMinutes`。
       * 2026-10-07 踩过：路由算得好好的，执行却回「没说明白什么时候」——
       * 因为 `runReminderTool` 认的是 `after_minutes`。工具 schema 是 snake_case，
       * 而**它自己（模型）是照着 schema 传的**，所以模型那条路一直没事；
       * 只有我手写的路由踩了。改名字这种错不会有编译错误，只会安静地不生效。
       */
      return afterMinutes
        ? { tool: 'set_reminder', args: { text: finalText, after_minutes: afterMinutes }, label: `定个 ${afterMinutes} 分钟后的提醒` }
        : { tool: 'set_reminder', args: { text: finalText, at }, label: `定个 ${at} 的提醒` };
    }
  }

  // 追加式：「再来两张」「再找几张」「多来点」—— 用**上一次的搜索词**（参数为空，由 bot.mjs 补）。
  // 2026-10-07 实测漏网：用户接着说「再来两张」，旧规则只认带「图/照片」的句子 → 又落回模型手里瞎搞。
  if (/^(?:那|再|又|还|多)?\s*(?:来|给|找|搜|要|发)\s*(?:个|一|两|三|几|些|点|多)?\s*(?:张|幅|个)?\s*(?:图|图片|照片|壁纸)\s*(?:吧|呗|吗|呀)?$/.test(s)) {
    return { tool: 'find_image', args: { more: true }, label: '再找几张图' };
  }

  // 只有量词的追问：「再来两张」「再找几张」。量词用「张/幅」，本身就说明在说图。
  if (/^(?:那|再|又|还|多)?\s*(?:来|给|找|搜|要|发)\s*(?:个|一|两|三|四|五|六|七|八|九|十|几|些|点|多)?\s*(?:张|幅)\s*(?:吧|呗|吗|呀|嘛)?$/.test(s)) {
    return { tool: 'find_image', args: { more: true }, label: '再找几张图' };
  }

  // ── 找图：**代码接管**（搜 + 自己下载 + 直接发），不让模型拼链接 ──
  // 2026-10-07 实测：模型没搜就用「记得的」地址、或把原站 CDN 链接当文字贴出来 ——
  // 用户点开全是失效/403，日志里全是「拦下 N 张网图」。
  // ⚠️ 句式要放宽（2026-10-07 实测漏网）：「**能**帮我找流萤的图片**吗**」「**那**帮我找**找**胡桃的同人图」
  //    —— 旧正则要求整句以「找/搜/来/要」开头，于是两句都没命中，路由没接管、模型自己瞎搞。
  const findImg = s.match(
    /^(?:能|能不能|可不可以|可以|那|你|麻烦|请|帮我|给我|帮)*\s*(?:找找|搜搜|找|搜|来|要)\s*(?:[一二两三四五六七八九十\d]{0,3}[张幅个下])?\s*([^，。！？]{1,18}?)\s*(?:的)?\s*(?:图片|照片|图|壁纸|同人图|大图|头像)\s*(?:吗|吧|呗|呀|啊|嘛)?$/u,
  );
  if (findImg && findImg[1]) {
    const q = findImg[1]
      .replace(/^[一二两三四五六七八九十\d]{1,3}[张幅个下]/, '')
      .replace(/^(?:的|一下|一个)+/, '')
      .trim();
    if (q) return { tool: 'find_image', args: { query: q }, label: `找「${q}」的图` };
  }

  // ── 截图：目标名要从句子里抠出来（"把哔哩哔哩截图发我" → 哔哩哔哩）──
  // 为什么要收这条：2026-10-07 用户说「把哔哩哔哩、歌词、dsh截个图发我」，
  // 模型**根本没调工具**，却回了「抓到了，我截了并发出去了」——日志里既没有 [tool] 也没有图片段。
  // 动词要**认全**：「截给我」「截一下」跟「截图」是同一件事
  // （2026-10-07 真实漏网：「把QQ音乐截给我」没命中，模型就编了句"抓到了，上传播"）
  const shotIdx = s.search(/(截图|截屏|截个图|截张图|截一张|截个|截一下|截给我|抓个图|抓张图|拍个图|拍一张)/);
  if (shotIdx >= 0) {
    /**
     * ⚠️ 开头那几个字是**噪音**，抠目标时要剥掉 ✓。
     * `吧` 是 2026-10-15 补的：拿归档里他的**真实发言**做审计时发现
     * 「**吧**dsh截一下」（他把「把」打成了「吧」✓）抠出来的目标是「吧dsh」✗ ——
     * 窗口名自然匹配不上 ✓。**他的错别字要在"抠参数"这一层兜住** ✓
     * （这一层是安全的：剥掉一个语气字不会把正常句子变成命令 ✓）。
     */
    const stripLead = /^(?:帮我|给我|麻烦|请|把|将|给|来|你|我|那个|这个|一下|吧|呗)+/g;
    // 句尾语气字（ba/a/ya/ne/o/ma/bei/ha/la），用 \u 转义写 => 源码纯 ASCII。
    // 2026-10-17：用户「帮我截一下gt吧」被抠成 match="gt吧"（吧被当成窗口名）=> 只剥句首不够。
    const stripParticle = /[\u5427\u554a\u5440\u5462\u54e6\u561b\u5457\u54c8\u5566\u5509]+$/;
    // 截图窗口别名表（2026-10-17）：用户会说简称。机器上实测的真实标题——
    //   我的世界整合包 -> "GT: New Horizons 2.8.4"（class GLFW30）
    //   本应用         -> "... - DeepSeek Harness"（class Chrome_WidgetWin_1）
    const SHOT_ALIAS = [
      // ⚠️ 用**窗口类名**而不是标题：我的世界(Java) 的标题随整合包变 ✗，
      //    但 GLFW30 这个类名不变 ✓ ⇒ 以后换任何整合包，说「mc」都能截到 ✓。
      [/^(?:mc|minecraft|我的世界|麦块)$/i, "GLFW30"],
      [/^(?:gt|gtnh|gt:?\s?nh|new\s?horizons)$/i, "New Horizons"],
      [/^(?:dsh|deepseek|harness)$/i, "DeepSeek Harness"], // 标题里就带这个名字 ✓
    ];
    const aliasOf = (t) => {
      const k = String(t == null ? "" : t).trim();
      const hit = SHOT_ALIAS.find(([re]) => re.test(k));
      return hit ? hit[1] : k;
    };
    const stripTail = /(?:那个|这个|的窗口|窗口|的图|图)$/g;
    const noise = /^(?:就|那|这|快|先|帮我|给我|你|我|一下|吧|呗|啊|的|了|一个|一张)*$/;
    // 写法一：目标在动词**前面** —— 「把哔哩哔哩截图发我」（多个目标时取第一个）
    const head = s.slice(0, shotIdx).replace(/[，,。.！!？?、：:\s]+$/g, '');
    const first = (head.split(/[，,。.！!？?、：:\s]+/).filter(Boolean)[0] ?? "")
      .replace(stripLead, "")
      .replace(stripTail, "")
      .replace(stripParticle, "")
      .trim();
    if (first && first.length <= 20 && !noise.test(first)) {
      return { tool: 'screenshot_window', args: { match: aliasOf(first) }, label: `截「${aliasOf(first)}」这个窗口` };
    }
    // 写法二：目标在动词**后面** —— 「截个歌词的图」「截一张 dsh」
    const tail = s
      .replace(/^(?:帮我|给我|麻烦|请|把|将)?\s*/, '')
      .replace(/^(?:截图|截个图|截张图|截一张|截个|截一下|截屏|抓个图|抓张图|拍个图)\s*/, '')
      .replace(/(?:的图|的窗口|窗口|图)\s*$/g, '')
      .trim();
    const tail2 = aliasOf(tail.replace(stripParticle, "").trim());
    if (tail2 && tail2.length <= 20 && !noise.test(tail2) && !/[截抓拍]/.test(tail2)) {
      return { tool: 'screenshot_window', args: { match: tail2 }, label: `截「${tail2}」这个窗口` };
    }
    // 说不清截哪个 → **也接管**：交给「上一次记住的那个窗口」；
    // 连目标都没有时，由工具回一句"说个大概就行"，比让模型自己编强。
    return { tool: 'screenshot_window', args: { match: '' }, label: '截个图' };
  }

  // ── 只读的电脑状态（零风险，顺手也路由掉）──
  if (/(有哪些窗口|开了什么窗口|什么窗口|窗口列表)/.test(s)) {
    return { tool: 'computer_status', args: { kind: 'windows' }, label: '看窗口列表' };
  }
  if (/(什么进程|内存占用|占用|哪个程序吃|占内存|占cpu)/i.test(s)) {
    return { tool: 'computer_status', args: { kind: 'processes' }, label: '看进程占用' };
  }
  if (/(电脑|系统|机器)[^。！？]{0,4}(状态|怎么样|卡不卡|还好吗)|卡不卡/.test(s)) {
    return { tool: 'computer_status', args: { kind: 'status' }, label: '看电脑状态' };
  }

  return null;
}

/**
 * ⚠️ 2026-10-10 用户报「搜图还有点问题」：他把「帮我找白丝洁哥的图」和「终末地的」**分成两条**发，
 * 机器人的**合并窗口**把它们拼成一条**带换行**的消息 —— 而上面那些规则都带 `^` 锚点，
 * 于是整句匹配不上 → 找图不接管，落回模型手里（它自己调 search_images，三连空）。
 * 所以：整句先试；不中就把每一行**单独**再试一遍（合并前的原话本来就是一行一条）。
 */
export function matchIntent(raw, { refs = null, pending = '' } = {}) {
  const whole = matchIntentLines(raw, { refs, pending });
  if (whole) return whole;
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  for (const line of lines) {
    const hit = matchIntentLines(line, { refs, pending });
    if (hit) return hit;
  }
  return null;
}

/**
 * **弱信号**：这句话"像是在要图"，但还没强到能被上面的规则接管。
 *
 * ⚠️ 它**只用来两件事**（2026-10-10 用户要求）：
 *   ① 记一行 `[找图·漏网]` 日志 + 落进 `logs/intent-misses.jsonl`，方便定期收网补规则；
 *   ② 当场给模型一句提示"你可以调 search_images（它会直接把图发出去）"，让它兜底。
 * **绝不用它来接管**（放行门槛必须高）—— 设计上就是"宽进日志、严进接管"。
 */
export function looksLikeImageAsk(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 60) return false;
  /**
   * ⚠️ **先排掉"我要用文字描述给你"这种说法**（2026-10-15 加）。
   *
   * 起因：拿归档里他的**真实发言**审计这条弱信号 ✓，发现
   * 「这是我在小黑盒看到的 meme **图**，我用文字描述**给**你」被判成"想找图" ✗ ——
   * 句子里的 `图` 与 `给` 各自出现了一次就命中了 ✓（弱信号本来就是"宽进"✓）。
   * 它**不会接管**（只记日志 + 给模型一句提示 ✓），但会给模型错误暗示 ✗ ⇒ 这里明确排掉 ✓。
   */
  if (/(文字描述|描述给你|口述|说给你听|用文字说)/.test(t)) return false;
  /**
   * ⚠️ **「表情包」不是在要图**（2026-10-18 加；真机日志：用户说「好嘞，你发个表情包」✓
   * ⇒ 被这条弱信号判成"想找图" ✗ ⇒ 给模型的提示变成"你可以调 search_images" ✗ 方向全错 ✓）。
   * 她要发表情包走的是 `[[图:标签]]` 那条（模型自己的标记 ✓），**跟搜图是两码事** ✓。
   */
  if (/(表情包|贴纸|sticker|meme)/i.test(t)) return false;
  const what = /图|照片|壁纸|图包|立绘|插画/;
  const ask = /找|搜|来|要|给|发|有|看看|想看|能不能|帮我/;
  return what.test(t) && ask.test(t);
}
