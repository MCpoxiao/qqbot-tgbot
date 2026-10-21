import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 所有可调项的默认值。config.json 只写要覆盖的部分即可。
 * 环境变量可以覆盖 llm.provider（BOT_PROVIDER）与 onebot.url（BOT_ONEBOT_URL）。
 */
export const DEFAULTS = {
  /**
   * **传输层**（2026-10-14 加）：'onebot'（QQ，默认，行为不变 ✓）| 'telegram'（TG ✓）。
   * 为什么加：QQ 那条路靠第三方客户端（NapCat 注入 QQNT），10-13 账号受限、10-14 被以「外挂风险」
   * 踢下线 1 小时 16 分（那段时间的消息永久丢失 ✗）。TG 的 Bot API 是官方且鼓励的 ✓、不会被封 ✓、
   * **也不需要第二个号** ✓。切换只改这一个值 ✓（代码那边靠「同一套接口」复用全部人格/记忆/能力 ✓）。
   */
  transport: 'onebot',
  onebot: {
    url: 'ws://127.0.0.1:3001',
    token: '',
    reconnectMs: 3000,
    maxReconnectMs: 60000,
  },
  /**
   * **Telegram 传输层**（用户 2026-10-14 决定「那就 tg」）。
   * ⚠️ **token 绝不写进配置/日志/记忆** ✗ —— 放 qq-bot/telegram-token.txt 一行（或环境变量 TELEGRAM_BOT_TOKEN）。
   * masterUserId 是你的 TG 数字 id ✓；留空的话**第一次私聊的人会被当成主人**（并打一行醒目的日志 ✓）。
   */
  telegram: {
    enabled: true,
    /**
     * **语音发送**（2026-10-14 用户要求）：本地 SAPI 合成 → ffmpeg 转 ogg/opus → sendVoice ✓。
     * 这台机器实测有 4 个中文嗓子（Huihui Desktop / Huihui / Kangkang / Yaoyao ✓）；
     * 合成失败会**自动降级成文字** ✓（不会哑掉 ✗）。
     */
    voiceName: 'Microsoft Yaoyao',
    voiceRate: 2,
    tokenFile: 'qq-bot/telegram-token.txt',
    masterUserId: '',
    pollSeconds: 10,
  },
  trigger: {
    // private: all | whitelist | off
    // group:   mention | all | keyword | off
    private: 'all',
    group: 'mention',
    // 群里「带图 +（引用某条消息 或 文本里有 @）」也算在跟它说话 —— 让群友也能用它识图。
    // 置 false 可关掉（回到「只认 @ 它 / 引用它的消息」）。
    groupImageReply: true,
    keywords: ['机器人'],
  },
  whitelist: {
    // 按场景各自生效：**空列表 = 该场景不限制**；填了 QQ/群号 = 只理名单内的。
    users: [], // 私聊白名单：填你自己的 QQ
    groups: [], // 群白名单：留空表示所有群都允许（再受 trigger.group 的 @ 限制）
  },
  stickers: {
    // 表情包目录（相对 qq-bot/）。文件名即标签，见 src/stickers.mjs。
    dir: 'stickers',
  },
  master: {
    /**
     * **称呼分场景**（2026-10-12 用户指定）：
     *   · `title`  = 正式称呼（沿用「主人」）
     *   · `alias`  = **平常**用的那个（用户说平常就「老大/主人」）
     *   · `address.flirty` = **暧昧**时的亲昵称呼；`address.bratty` = **犯贱**时用的（打情骂俏的贬称）
     * ⚠️ 两条硬约束（用户强调过多次）：**他带了称呼就跟**；**不带就绝不强求**（别每句都挂称呼）。
     */
    alias: '老大',
    address: {
      flirty: ['亲爱的', '宝贝'],
      bratty: ['杂鱼'],
    },
    // 只有名单里的 QQ 号会被称作「主人」。留空 = 谁都不叫主人。
    // 这个称呼是**按每条消息动态注入**的，不是写死在人格里——
    // 否则群里其他人也会被叫「主人」。
    users: [],
    title: '主人',
    // 把主人当恋人（**只影响对主人**，对别人一个字都不变）。
    // 默认关：新克隆一份配置不该自带恋爱关系。
    romantic: false,
  },
  tools: {
    // 让它真的能做事（查天气、查时间）。关掉就退回纯聊天。
    enabled: true,
    maxRounds: 4, // 工具调用最多循环几轮
    enabledTools: [], // 空 = 全部可用；填 ['get_weather'] 就只开这一个
  },
  approvals: {
    // 「有个审批在等你」转发到主人私聊 —— **只通知，不能替他点同意**
    // （为什么不做远程点同意，见 src/approvals.mjs 开头）。
    // 没配主人名单（master.users）时不发。
    enabled: true,
    pollMs: 15000,
    // DSH 的会话根目录。空 = 默认 `~/.dsh/sessions`；自测会指到临时目录。
    sessionsDir: '',
  },
  reminders: {
    // 「X 分钟后提醒我」——**真的会响**的定时（详见 src/reminders.mjs）。
    // 和操控一样**只给主人的私聊**。
    enabled: true,
    // 落盘文件（相对 qq-bot/）。**自测必须换掉它** —— 否则跑一次自测就会
    // 动到真实待提醒队列（发出去 / 被摘掉），跟当年 sessions.json 那个坑同一类。
    file: 'logs/reminders.json',
  },
  control: {
    // 「让机器人动手」的总开关。**只有主人的私聊**能触发（见 src/control.mjs）：
    // 群里连这些工具的定义都不会注入，所以不存在"群友诱导它关机"这条路径。
    enabled: true,
    // 能打开的应用白名单。**必须是绝对路径**，面板上按「名字 = 路径」一行一条填。
    // 空列表 = 一个也开不了（**不是"全都能开"**）。
    apps: [],
    // 「只读文件发我」允许的目录。空 = 不开放。
    files: { roots: [] },
    screenshot: {
      // 窗口截图的**进程名黑名单**（小写子串匹配）：命中就拒绝截图。
      // 截图不做"应用白名单"——要截的窗口往往是临时的、事先想不到的；
      // 真正对症的是黑名单（泄露的对象是特定的那几类）+ 只要窗口不要全屏。
      blocklist: ['keepass', 'bitwarden', '1password', 'lastpass', 'bank'],
    },
  },
  chat: {
    /**
     * **"正在输入"状态**（2026-10-12 用户要求：「我看网上说要有对方正在输入才可以避免」）。
     * 事实核查：NapCat 支持 `set_input_status`（[官方 API 文档](https://napneko.github.io/onebot/api)）✓；
     * 但**"能防封"无法证实**（社区说法、无官方依据）✗ —— 它属于"增加人类信号"，方向合理、成本近零，所以做上。
     * 只对私聊生效（接口参数是 `user_id`）。`typingHoldMs` 是"显示正在输入到真正发出"之间的停顿
     * （默认 0.4~1.1 秒随机）；设成 0 就完全不延迟。
     */
    typingIndicator: true,
    typingEventType: 1, // **实测确认 1 = 正在输入**（2026-10-12 用户亲眼看到 ✓）；官方文档没列这个取值
    typingStopEventType: 0, // 发完收掉状态
    typingHoldMs: [400, 1100], // [下限, 上限] 毫秒；0 = 不延迟
    /**
     * **回复前的随机抖动**（2026-10-12 用户要求「回复延迟加抖动」）。
     * 实测我们的回复**中位延迟 1531ms**、几乎恒定 —— 「永远 1.5 秒回」本身就是机器特征。
     *   ① `replyJitterMs`：基础抖动（默认 0.3~1.8 秒随机）
     *   ② `replyLongChance`：这么大概率再加一段"走神/在忙"的长尾（`replyLongMs`，默认 2.5~7 秒）
     * 想恢复"尽量快"就把 `replyJitterMs` 设成 `[0, 0]`、`replyLongChance` 设成 0。
     */
    replyJitterMs: [200, 800], // 2026-10-13 从 [300,1800] 调小：回复快约 1 秒，但仍不是恒定值
    replyLongChance: 0.06, // 2026-10-13 从 0.12 减半（长尾少一半）
    replyLongMs: [1500, 4000], // 2026-10-13 从 [2500,7000] 调小
    // 把回复按段落拆成几条消息发，像人一样。关掉就整条发一条长消息。
    // 刻意没有"短句合并阈值"——人发消息就是短句连发，合并会把效果抹掉。
    bubbles: true,
    maxBubbles: 4,
    delayMs: 1200, // 每条之间的基础停顿
    delayPerChar: 45, // 每个字再加这么多毫秒（模拟打字）
    delayMax: 4500, // 单次停顿上限，别让人干等
    maxWebImages: 4,
    findImage: true, // 「找 X 的图」由代码搜 + 自己下载再发（不让模型拼链接）
    webImagesInGroup: true, // 群里也允许发网图（因为我们发的是下载下来的本体，不依赖外链） // 一条回复里最多发几张网图（私聊和群里都一样）
  },
  bilibili: {
    // 看视频时顺便读「画面」：把 B站 的进度条缩略图网格交给视觉模型。
    // 每格只有 160×90 —— **能看出场景 / 人物 / 大致变化，看不出细节动作**。
    // 成本：一张图约 60KB、约 950 prompt token。关掉就只看字幕。
    describeFrames: true,
    // 消息里出现 B站 / b23.tv 链接时，**代码直接去读**，不等模型自己决定调工具。
    // 实测模型不会主动调：它看到消息里带着标题就以为够了（1450ms 就回了，
    // 还替自己编了句「短链不给内容」—— 而那条短链其实完全能解析）。
    autoReadLinks: true,
  },
  /**
   * 找图（Bing 搜图）的行为（2026-10-09 用户要求）：
   *  · `repeatWindowHours`：**短时间内不重复** —— 跨会话、落盘，窗口内发过的图不再发（默认 24 小时）；
   *  · `screen`：**发前筛一遍** —— 让视觉模型判断"这张能不能当搜索结果发出去"，不合适的不发；
   *  · `sentFile`：那份"近期发过的图"落在哪。
   */
  imageSearch: {
    repeatWindowHours: 24,
    screen: true,
    sentFile: 'logs/sent-images.json',
    // pixiv 源：'auto'（默认，有代理就用）| 'off'（只用 Bing）。要代理才连得通，见 start-all.ps1。
    pixiv: 'auto',
    /**
     * **重名先问**（2026-10-10 用户要求）：这些名字有好几个出处，他说的话里没指明哪个作品时，
     * **先问一句**再搜（而不是拿到哪个算哪个）。
     */
    ambiguous: {
      // 两种写法都认：数组 = 只有出处；对象 = 出处 + **正式名**（用于确认后去搜图）。
      '胡桃': { works: ['原神', '蔚蓝档案'], name: '胡桃' },
      '洁哥': { works: ['明日方舟', '明日方舟：终末地'], name: '洁尔佩塔' },
      '洁尔佩塔': { works: ['明日方舟：终末地'], name: '洁尔佩塔' },
    },
  },
  vision: {
    /**
     * **图片要先压小再发给视觉模型**（2026-10-12 加，2026-10-13 实测确认 ✓）。
     * 实测同一张 1038KB 的图：**原图 60 秒超时**（有一次 58.7 秒），
     * 缩到 **89KB 后 6~8 秒**就回来、且**认得一样准**（读出了袋子上「Cotti Coffee」和 shoe/路面等细节 ✓）。
     * ⇒ 缩图不是"省事"，是**能不能读出来**的分界线 ✓。
     */
    shrink: true,
    shrinkAboveBytes: 600 * 1024, // 超过这个大小就压
    maxWidth: 1280, // 压到这个宽度（实测够用：20px 小水印/丝印都读得出）
    /**
     * **压不小就别发**（2026-10-13 加）：缩图失败还硬发原图 = 白等 60 秒 ✗。
     * 超过这个大小又没压小 ⇒ 这次不读，让她照实说"图太大读不出来"。
     */
    skipAboveBytes: 900 * 1024,
    // 读图：把用户发的图交给视觉模型，转成文字描述再进上下文。
    // 走 llm.mjs 里已有的 askWithImage（DeepSeek 认 image_url 的 data: URL），
    // **不需要装任何本地视觉模型**。
    // 注意：每张图多一次 API 调用（240×240 约 190 prompt token），所以别开太大。
    maxImages: 2, // 一轮最多读几张
    // 顺便用 trace.moe 溯源「这张动漫截图出自哪」——免费、免 key，**只对动漫有效**。
    // 它不是万能的：照片/表情包/游戏 CG 会返回空，那是正常的。
    identifyAnime: true,
  },
  /**
   * **视频理解**（2026-10-11，用户批准装 ffmpeg 之后加的）。
   *
   * 帧数的来历：用户原话「ffmpeg 可以，但是多抽点，**一分钟视频至少抽 20 帧**吧」——
   * 我原本设想的是"整条视频抽 3~4 帧"（那是看个大概），确认后按 **20 帧/分钟** 实现。
   * 省 token 的关键是**拼图**（一张图里放 20 个画面、一次调用看完）；
   * 还想更省就调小 `frameWidth`（每格宽度）或降 `framesPerMinute`。
   */
  video: {
    enabled: true,
    framesPerMinute: 20, // 每分钟抽几帧（用户要求 ≥20；≈每 3 秒一帧）
    /**
     * ⚠️ **上限是按用户的真实用量定的**（2026-10-11 他说：视频基本是 **5~6 分钟**，
     * 抖音看到有意思的下载下来发过来，不怎么发）：
     *   · 原来 `60 帧 / 300 秒` → **6 分钟的视频会被截成前 5 分钟、密度还掉到 5 秒一帧** ✗
     *     （低于他要求的 20 帧/分钟，等于两头都没满足）；
     *   · 现在 150 帧 / 600 秒 → 6 分钟 = **120 帧、3 秒一帧、全片覆盖、6 张拼图**，
     *     成本约 **0.01 元**（实测：拼图 ≈1196 tokens/张），耗时约 40 秒（软截止已放到 120 秒）。
     */
    maxFrames: 150, // 150 帧 = 7.5 分钟 @20帧/分钟
    maxSeconds: 600, // 最多看前多少秒（10 分钟；超了只报"只看了前一段"）
    /**
     * **拼图每格宽度**。实测（2026-10-11，造"抖音风格"测试片做的对照实验）：
     *   · **大字幕**（抖音那种烧进画面的字幕）：480 / 320 / **240** 都能 6/6 读对 ✓
     *   · **小字**（20px 水印/ID/UI 小字）：**480 就已经读不到**，而且**调大到 720 也没用**
     *     （480 与 720 的 token 数完全相同 = 1196 → 说明拼图会被**归一化**，提宽不增细节）；
     *     再大到 960 会因**请求过大被服务端掐断**（实测写了 2.3MB 后 `SocketError`）✗
     *   · 想在视频里读小字，唯一有效的办法是 **`mode: 'each'` 逐帧**：
     *     单帧 1280px 时模型**准确读出了**水印（602 tokens/帧），而单帧 480px 读不清。
     * 所以默认保持 480（给中等字号留余量）；纯大字幕的抖音视频可以用 320（省 ~24%，token 1196→907）。
     */
    frameWidth: 480,
    sheetCols: 5, // 拼图每行几格
    sheetRows: 4, // 拼图几行（5×4 = 20 格一张）
    mode: 'sheet', // 'sheet' = 拼图一次看完（默认）；'each' = 逐帧（贵但细，才能读小字）
    maxBytes: 41943040, // 视频文件上限 40MB（超了就不下，只说"看不了"）
    timeoutMs: 120000, // 整体软截止：到点就用已拿到的画面收尾（6 分钟视频约 40 秒，留余量）
    ffmpeg: '', // 留空 = 自动找（PATH + winget 包目录）
    ffprobe: '',
  },
  voice: {
    // 让它"说话"：调 **QQ 自带的 AI 语音**（不是我们合成/下载音频，不涉版权内容）。
    // **提示词要求"只有被明确要求才发"，这里再加一道代码闸**——
    // 实测"别频繁"这种话光写进提示词不可靠（禁止性措辞会被忽略或被过度执行）。
    enabled: true,
    character: 'lucy-voice-xueling', // 元气少女（`get_ai_characters` 可查全部音色）
    maxPerReply: 1,
    minIntervalMs: 300000, // 同一个会话里两次语音的最小间隔（默认 5 分钟）
  },
  music: {
    // 允许它点歌（QQ音乐卡片）。搜不到会换成一句说明，不会发出空气。
    enabled: true,
    maxPerReply: 1, // 一条回复最多放几首
  },
  /**
   * 长期记忆：档案（事实，带时效）+ 日记（情节）+ 待审批草稿。
   * 详见 src/memory.mjs 开头 —— 核心是"模型只提取、代码才写、先审后记"。
   */
  /**
   * 「自己上网冲浪」：**随机间隔**（40~150 分钟）或者**他觉得无聊了**（主人太久没说话）就去看看新鲜事，
   * 挑一条没发过的写成一句话发主人私聊。触发条件在代码里（见 src/surf.mjs），模型只负责写那句话。
   */
  /**
   * **7 天聊天记录归档**（2026-10-11 用户要求：「7 天内的所有聊天记录都保存下来作为完整记忆，
   * 第八天删第一天的，重要的还是留到长期里」）。实现见 `src/chatlog.mjs`。
   *
   * ⚠️ 默认值是**按本机实测算出来的，不是拍的**（2026-10-11 量的）：
   *   · 每天约 **200~300 条**消息、平均 **13 字** → 文字部分约 **0.1MB/天**（**一年也才 ~40MB**）；
   *   · 真正的开销是**图片**：本机样本平均 **1.77MB/张**（最大 4.85MB）；
   *   · 工作区在 **C:**，而 C: 当时**只剩 14.1GB**（D: 有 71GB）→ 所以必须卡：
   *     `maxDayMediaBytes` 默认 **50MB/天**（≈350MB/周）；`maxTotalBytes` 默认 **2GB**
   *     （超过就**只记文字、不再存图**并告警 —— 宁可少存图，也不许把系统盘吃满）。
   *   想要更长的窗口（30~90 天）：把 `dir` 挪到 D:，或把 `saveMedia` 关掉（文字档照样完整）。
   */
  chatArchive: {
    enabled: true,
    /**
     * **归档根目录**。用户 2026-10-11 指定的结构（`src/chatlog.mjs` 实现）：
     * ```
     * 小笛记忆/2026.10.11/记忆/13-58-20.jsonl  每小时一个追加档；档名=挂档那一刻的时分秒（没消息就不建）
     * 小笛记忆/2026.10.11/图片/<sha16>.jpg  图片与那天放一起（按内容去重）
     * ```
     * ⚠️ 本机 2026-10-11 用户要求把它放 **D 盘**（config.json 里写的是 D:/小笛记忆）；
     * 这里的默认值保持相对路径，方便换机器；绝对路径写在 config.json（可热重载）。
     */
    dir: '小笛记忆',
    /**
     * **图片单独放一个盘**（用户有一块 4T 机械盘；挂上后填它的盘符，例如 'E:/xiaodi-chat-media'）。
     * 留空 = 跟随 `dir`。**故意分开**的理由：文字档极小（0.18MB/天），放系统盘永远在；
     * 图片大、而且那块盘可能**拔走** —— 盘不在时丢的只是图，**对话原文一个字不少**。
     */
    mediaDir: '',
    /**
     * **本地暂存目录**（归档盘不可用时的落地处，2026-10-11 加）。
     * ⚠️ 用户以后要用 **iSCSI 挂 NAS 的网盘**（现在先直连机械盘）：网络盘**开机时可能还没挂上**、
     * **中途会掉**，而且**卡住时会把 I/O 拖到分钟级** —— 那期间的记录先写这里、等盘回来自动搬过去。
     * **必须放在本地盘**（默认 `<dir>-spool`）；指到同一个网络盘就失去意义了。
     */
    spoolDir: '',
    /**
     * **保留期**：`0 = 永久保留`（2026-10-13 用户要求去掉 7 天限制：「我硬盘估计一两个月左右就买了」）。
     * ⚠️ 归档目前总共才 4MB、D 盘余 69GB —— 7 天限制纯属白删数据 ✗。
     * 注意：老代码是 `Math.max(1, ttlDays || 7)`，**0 会被当成 7** ✗ —— 现已显式支持 0 ✓（改这里前先看 prunePlan）。
     */
    ttlDays: 0,
    /**
     * **回忆窗口**：查询默认往后看几天（默认 7）。跟 ttlDays 是**两件事** ——
     * 不拆开的话，"永久保留"会让每次关键词搜索都扫全库 ✗。想让她默认搜更远就调大这个。
     */
    recallDays: 7, // 滚动窗口：第 8 天删第 1 天
    saveMedia: true, // 图片落盘（关掉就只记 URL，文字档不受影响）
    maxMediaBytes: 8 * 1024 * 1024, // 单张图片上限（超过就不存那张）
    /**
     * **视频单独一套上限**（2026-10-11 用户说「图片、视频也要能找」）：
     * 短视频通常几 MB；长视频直接跳过，免得一块视频把当天额度吃光。
     */
    maxVideoBytes: 20 * 1024 * 1024,
    maxDayMediaBytes: 50 * 1024 * 1024, // 每天图片总量上限（实测依据见上）
    maxTotalBytes: 2 * 1024 * 1024 * 1024, // 整个归档上限：超了就只记文字 + 告警
    /**
     * **时钟往回跳时的处理**（用户会故意改系统时间玩 ARG —— 2026-10-11 他确认过）。
     * `true`（默认）：把日期挂到"上次正常日"上并标记 `clockSuspect` ——
     * 消息不会散进 `2003-…jsonl` 那种档里，也就不会被滚动清理误删，7 天窗口照常连得上。
     * `false`：归档跟着假时钟走（那一档也不会被自动删，只在日志里报告）。
     */
    clockGuard: true,
  },
  surf: {
    enabled: true,
    checkEveryMinutes: 10, // 多久检查一次该不该去玩
    minGapMinutes: 60, // 两次冲浪的最小间隔（在这个区间里**随机**取）—— 2026-10-12 从 40 调大（降机器味）
    maxGapMinutes: 240, // 2026-10-12 从 150 调大
    boredAfterMinutes: 180, // 主人这么久没说话 = 无聊，可以主动出去看看
    minGapWhenBored: 60, // 无聊状态下最短也要隔这么久，别连着刷（2026-10-12 从 30 调大）
    dailyMax: 4, // 一天最多几条（2026-10-12 从 8 降到 4 —— 主动发消息太多是机器特征）
    /**
     * ⚠️ **取材查询词**（2026-10-12 加，用户问「为什么卡新闻了」）：
     * 原来写死成 `'今日热点新闻'` ⇒ 搜索回来一堆新闻站，她隔一会儿就发一条新闻。
     * 现在从这组词里**按时间轮换**（10 分钟粒度）；想只要新闻就把它减成一个词。
     */
    queries: [
      '今日热点新闻',
      '最近有什么新奇有趣的事',
      '冷知识 有意思',
      '最近好玩的视频',
      '科技 数码 新东西',
    ],
    /**
     * **新闻站降权**：这些域名命中的素材**排到最后**（不禁用）——
     * 视频要过"看懂"审、新闻不用，所以新闻几乎必发；降权后优先发视频/别的来源。
     */
    avoidDomains: ['cctv.com', 'people.com.cn', 'sina.com.cn', '163.com', 'toutiao.com', 'thepaper.cn', 'xinhuanet.com', 'chinanews.com'],
    hourFrom: 9, // 安静时段：这之外不发
    hourTo: 23,
  },
  /**
   * 「她自己的账号，她自己管」（2026-10-08 用户定；实现见 src/qqact.mjs）。
   *
   * 规则：**对外新增/改变要审，收回/撤销免审。**
   *   · 要审：发说说、改昵称/签名、换头像 → 先存草稿，主人点头才动账号；
   *   · 免审：删说说、回滚上一版、在线状态。
   * 上面那几项 **只给主人私聊**（群里连工具定义都看不到）。
   *
   * `max*PerDay` 是**每天最多几次**（0 / 不填 = 不限）。计数从审计日志 `logs/qq-act.log` 现算，
   * 不另存状态文件 —— 少一份会跟日志对不上的东西。
   */
  qqAct: {
    enabled: true,
    /**
     * 「签名 / 昵称 / QQ空间说说**由她自己决定什么时候动**，主人只审批」（2026-10-09 用户定）。
     * 打开时会在系统提示词里加一段（见 `qacht.selfInitiatedHint`）告诉她：
     * 想动就自己拟一版 → 念给主人听 → 他点头才执行；**点头之前一个字都不能动，也不许说"已经做了"**。
     */
    selfInitiated: true,
    /**
     * ⚠️ 这个标志**曾经被我用来"关掉昵称"**，因为 `get_login_info` 连续 6 次返回旧值，
     * 让我误判"昵称改不动"。**后来用户说他那边昵称确实变了** —— 那个接口给的是**缓存值**。
     * 所以这条路**是通的**，标志留着只为将来真有可信证据时用；默认 `true`。
     */
    nicknameWorks: true,
    maxPostPerDay: 3, // 说说：一天最多发几条（防"一天八条"刷屏）
    maxProfilePerDay: 1, // 改昵称/签名：一天一次就够了
    maxAvatarPerDay: 1, // 换头像：同上
    maxDeletePerDay: 10, // 删说说基本不拦，只防手滑连删
  },
  /**
   * B站 侧的动作（`src/biliact.mjs`）—— 与 QQ 侧同一套纪律，审不审的分界也一样：
   * **赞 / 投币 / 收藏免审（但都有每日上限）**，**关注要审、取关免审**。
   * 写接口必须有 `bili_jct`（面板「B站登录」第二个框）；没填时不做请求、直接说清楚。
   *
   * ⚠️ 投币**要花硬币**（真金白银换的），所以 `maxCoinPerDay` 默认给得很紧（5）。
   */
  biliAct: {
    enabled: true,
    maxLikePerDay: 20, // 点赞/取消赞：宽一点，但别刷
    maxCoinPerDay: 5, // 投币：上限最紧（花硬币）
    maxFavPerDay: 20, // 收藏
    maxFollowPerDay: 5, // 关注（这条本来就要审，上限是第二道闸）
  },
  memory: {
    enabled: true,
    file: 'logs/memory.json',
    maxInjectChars: 1200, // 注入预算：记忆不能抢戏，否则人格被一堆事实淹掉
    diaryDays: 2, // 注入最近几天的日记
    nearTtlDays: 14, // 「近期」事实多久后自动失效（长期偏好不受影响）
    draftTtlHours: 12, // 草稿挂多久没人审就作废
    // **它自己提整理**：攒够这么多条新对话就自己整理一轮，把草稿发主人审（不打搅、不自动落盘）。
    autoMinFresh: 8, // 少于这么多条新对话就不提
    autoEveryMinutes: 30, // 多久检查一次
    autoCooldownHours: 6, // 同一会话两次自动整理至少隔这么久
    autoHourFrom: 9, // 只在白天提（免得半夜发消息）
    autoHourTo: 23,
  },  tone: {
    // 语气叠加层。'genki' = 元气少女口吻（只改怎么说，不改说什么和篇幅）；
    // '' = 关掉，退回人格原本的写法。
    vibe: 'genki',
    // 嘴硬频率**由代码控制**，不交给模型数数（实测它数不准，会在"每条都嘴臭"和
    // "一条都不嘴臭"之间来回摆）。这里 N 表示每 N 轮里放行 1 轮可以嘴硬。
    // 0 或 1 = 从不嘴硬；2 = 隔一条；3 = 每三条一次。默认 3。
    bratEveryN: 3,
    // 「该嘴臭」的**内容触发词**（2026-10-09 用户要求）：群友说「妈妈」「看看脚」这类欠收拾的话，
    // **当场**就该嘴臭，不用等排期。这是**额外的放行**，不是新限制 —— 排期照旧，主人也不受额外约束。
    brattyTriggers: ['妈妈', '叫妈', '看看脚', '看看腿', '看看jio', '看看脚脚', '踩我', '舔', '叫爸爸', '跪下', '狗叫', '喊哥哥', '闻闻'],
    // 出现「杂鱼」时把那句句末改成 ~（纯机械改写，由代码保证）
    bratTilde: true,
  },
  proactive: {
    // 长时间没消息时机器人主动开口。
    // 默认**关闭**：主动发消息比被动回复更容易触发风控，请看清楚再开。
    enabled: false,
    afterMinutes: 180, // 安静多久才考虑开口
    minGapMinutes: 240, // 两次主动开口之间至少隔多久
    maxPerDay: 2, // 每天最多主动开口几次
    groups: false, // 是否也在群里主动开口（默认不，群里刷屏很招人烦）
    quietHours: { from: 23, to: 8 }, // 免打扰时段，本地时间，可跨午夜
    prompt:
      '主人已经有一阵子没动静了。用你的口吻主动开一句，像等久了忍不住探个头看看，两三句以内。别提「超时」「定时」「主动」这类词，也别追问对方为什么不回。',
  },
  limits: {
    cooldownMs: 2500,
    // 非主人在群里的频率闸：windowMs 内最多 max 次（主人不受限）。
    groupRate: { max: 3, windowMs: 3 * 60 * 1000 },
    // 主人私聊的**连发合并窗口**：这么多毫秒内接着发的消息合成一轮（不再丢消息）。
    mergeMs: 1200,
    mergeMaxMs: 6000, // 从第一条算起最多等这么久，免得一直发就一直不回
    maxReplyChars: 900,
    maxInputChars: 2000,
    historyTurns: 6,
    // 历史的总字符上限。只按轮数限制不够——50 轮长消息能到十几万字，逼近模型上下文。
    // ~12000 字 ≈ 4000 token，日常聊天完全够，也留足余量给人格和梗库。
    sessionMaxChars: 12000,
    // 空闲多久就把这段会话忘掉。以前是 30 分钟——太短了，用户会明显感觉"它不记得我"。
    // 上下文长度已经由 historyTurns 兜住，所以这里可以放宽。
    sessionTtlMs: 21600000,
    // 会话落盘的文件（相对 qq-bot 根目录）。设成空串就不再落盘。
    sessionFile: 'sessions.json',
  },
  llm: {
    provider: 'deepseek', // deepseek | ollama | echo
    system:
      '你是一个友好的 QQ 聊天助手。回答简短、口语化，通常不超过三句话。不要使用 Markdown 语法。',
    /**
     * ⚠️ **单次调用超时：60 秒 → 30 秒**（2026-10-15 改）。
     *
     * 起因：用户说「今晚聊天逻辑有点问题」✓，查下来一半是**慢** ✓ ——
     * 日志里 `[llm] 对话 第 N 次失败（请求超时（60000ms））` 反复出现 ✓，
     * 一次卡满 60 秒再重试 ⇒ 体感就是 11~29 秒的回复 ✓（正常 3~5 秒 ✓）。
     * 经代理到 DeepSeek 的链路本身在抖 ✓（和 TG/pixiv 同一个源 ✓）。
     * 30 秒够正常调用（实测 3~5 秒 ✓）✓，卡住时**更早放弃、更早重试** ✓ ——
     * 质量不受影响 ✓（重试逻辑照旧 ✓）。
     */
    timeoutMs: 30000,
    memesFile: 'memes.md', // 梗库（可编辑的纯文本，改了就热更新）
    deepseek: {
      baseUrl: 'https://api.deepseek.com',
      /**
     * ⚠️ **2026-10-11 从遗留别名改成显式名**。原来写的是 `deepseek-chat`，
     * 而 API 回包的 `model` 字段显示它实际被路由到 **`deepseek-flash`**（别名）。
     * 官方文档现在只列两个模型：`deepseek-flash`（**支持图像理解** ✓）与
     * `deepseek-v4-pro`（**不支持图像**、单价 4.5 倍）——
     * 万一哪天别名被改指向，她的识图/看视频会**静默失效**（不报错、只是读不出图）。
     * 所以写死实际在用的那个名字。
     */
    model: 'deepseek-flash',
    /**
     * **思考模式**（2026-10-12 加）。官方：`deepseek-flash` 支持非思考与思考模式，**默认是思考**。
     * ⚠️ 而**思考 token 和正文共用同一个输出预算** —— 预算被思考吃掉时**正文一个字都不剩**：
     * 2026-10-12 实测 `max_tokens:30` + 默认思考 → `content` 长度 **0**、`finish_reason=length`，
     * 当天日志里因此出现 3 次「模型返回了空内容」和 1 次"写半句就断"。
     * 关掉之后：正文正常、**快 4 倍**（3575ms→962ms）、输出 token **省约 90%**（思考 292→0）。
     * 她的人设不需要长推理 ⇒ 默认 `'disabled'`。要开回思考就改成 `'enabled'`。
     */
    thinking: 'disabled',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      // 环境变量读不到时，退回读这个文件（相对 qq-bot/）。每次请求都重读，改完不用重启。
      apiKeyFile: '.deepseek-key',
      temperature: 1.0,
      maxTokens: 800,
    },
    ollama: {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:8b',
      temperature: 0.7,
      numPredict: 800,
    },
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * 读配置：config.json 优先，没有就退回 config.example.json，再叠加默认值。
 * 传入 overrides 可在测试里直接改，不碰磁盘。
 */
export function loadConfig(overrides = {}) {
  const candidates = [
    process.env.BOT_CONFIG ? resolve(ROOT, process.env.BOT_CONFIG) : null,
    resolve(ROOT, 'config.json'),
    resolve(ROOT, 'config.example.json'),
  ].filter(Boolean);

  const source = candidates.find((p) => existsSync(p));
  let fromFile = {};
  if (source) {
    try {
      fromFile = JSON.parse(readFileSync(source, 'utf8'));
    } catch (err) {
      throw new Error(`配置文件解析失败 ${source}: ${err.message}`);
    }
  }

  let cfg = deepMerge(deepMerge(DEFAULTS, fromFile), overrides);

  if (process.env.BOT_PROVIDER) cfg.llm.provider = process.env.BOT_PROVIDER;
  if (process.env.BOT_ONEBOT_URL) cfg.onebot.url = process.env.BOT_ONEBOT_URL;
  if (process.env.BOT_SYSTEM_PROMPT) cfg.llm.system = process.env.BOT_SYSTEM_PROMPT;

  return { config: cfg, source };
}

/** 只报告"某个 provider 有没有配好"，绝不回显密钥本身。 */
export function describeBackend(cfg) {
  const provider = cfg.llm.provider;
  if (provider === 'echo') return 'echo（本地回显，仅用于自测）';
  if (provider === 'ollama') return `ollama @ ${cfg.llm.ollama.baseUrl} model=${cfg.llm.ollama.model}`;
  if (provider === 'deepseek') {
    const envName = cfg.llm.deepseek.apiKeyEnv;
    const file = cfg.llm.deepseek.apiKeyFile;
    const fromEnv = Boolean(process.env[envName]?.trim());
    let fromFile = false;
    if (!fromEnv && file) {
      try {
        fromFile = readFileSync(resolve(ROOT, file), 'utf8').trim().length > 0;
      } catch {
        fromFile = false;
      }
    }
    const where = fromEnv ? `已从 $${envName} 读到` : fromFile ? `已从文件 ${file} 读到` : `未配置（找过 $${envName} 和 ${file}）`;
    return `deepseek @ ${cfg.llm.deepseek.baseUrl} model=${cfg.llm.deepseek.model} 密钥=${where}`;
  }
  return `未知 provider: ${provider}`;
}
