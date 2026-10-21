# 小笛 · QQ / Telegram 聊天机器人

一个**零运行时依赖**的 Node.js（ESM）个人聊天机器人：同时支持 **QQ（OneBot / NapCat）** 与 **Telegram Bot API**，
带长期人格、表情包、语音、长期记忆、控制面板，以及（实验性的）**用 ADB 驱动安卓模拟器"玩手机"**。

> 这是**个人自用**的机器人，不是通用框架：很多决定是"和它相处一段时间后被真机打回来"才定下的。
> 每一步都有自测断言盯着，改完就跑 `node qq-bot/tools/selftest.mjs`。

---

## 目录

- [它能做什么](#它能做什么)
- [快速开始](#快速开始)
- [配置参考](#配置参考)
- [目录与文件职责](#目录与文件职责)
- [一条消息的旅程](#一条消息的旅程)
- [几个设计选择，和为什么](#几个设计选择-和为什么)
- [自测](#自测)
- [踩过的坑](#踩过的坑)
- [状态与限制](#状态与限制)

---

## 它能做什么

| 模块 | 说明 |
| --- | --- |
| **双传输** | QQ 走 OneBot 11（NapCat 协议端）；TG 走 Bot API 长轮询。两者共用同一套对话逻辑，靠 `transport` 切换 |
| **人格** | 系统提示里 4000+ 字的角色设定 + 独立的「语气层」（元气 / 俏皮毒舌），可热改 |
| **表情包** | 本地图库按标签取图：模型在回复末尾写 `[[图:标签]]`，代码把它换成真实图片段 |
| **语音** | Windows SAPI 合成；合成失败自动降级成文字（**不能因为没嗓子就不说话**） |
| **识图** | 图片交给视觉模型描述；引用回复也会带上下文 |
| **视频** | ffmpeg 按「每分钟 20 帧」抽帧 → 拼成一张图 → 让视觉模型看画面 + 时间线 |
| **长期记忆** | 聊天按天/小时归档成 jsonl（永久保留）；`recall_chat` 可按关键词或时间回查 |
| **联想记忆** | 你提到身体/情绪/生活里的事时，**代码层**去归档翻你以前说过的话，带日期塞进本轮提示（"你 10 月 12 号也说过肚子不舒服"） |
| **工具调用** | 22 个工具：天气、时间、搜索、搜图、B站、记忆、发说说、改签名、提醒、媒体控制、手机… |
| **控制面板** | `tools/panel-server.mjs`，浏览器里改配置、看日志、查归档 |
| **玩手机**（实验） | ADB 驱动雷电模拟器：截图 → 视觉模型读屏 → 点按；点完用**帧比对**判断到底有没有点中 |

---

## 快速开始

### 0. 前置

- **Node.js ≥ 22**（`package.json` 里写死了 `engines`）—— 用到内置 `fetch`、`AbortSignal.timeout` 等
- 平台：**Windows**（语音走 SAPI、窗口控制走 PowerShell + P/Invoke；其它平台需要自己换实现）
- 可选：`ffmpeg`（视频抽帧、截图压缩）、`adb`（玩手机；雷电模拟器自带）

```bash
git clone https://github.com/MCpoxiao/qqbot-tgbot.git
cd qqbot-tgbot
node qq-bot/bot.mjs          # 第一次跑会因为没配置而报错，看下面
```

### 1. 放好三个本地文件（都不入库）

| 文件 | 内容 | 必需 |
| --- | --- | --- |
| `qq-bot/config.json` | 配置覆盖（没有就用 `src/config.mjs` 里的默认值） | 建议 |
| `qq-bot/.deepseek-key` | 模型 API key（一行） | 必需（除非用 Ollama） |
| `qq-bot/telegram-token.txt` | TG bot token（可以带注释行，代码用正则搜） | 用 TG 时必需 |

### 2. 最小配置

`qq-bot/config.json` 只要写你要改的部分，其余走默认：

```json
{
  "transport": "telegram",
  "telegram": { "enabled": true, "masterUserId": "1000000000" },
  "llm": {
    "provider": "deepseek",
    "deepseek": { "model": "deepseek-chat" }
  },
  "master": { "users": ["10000000"], "title": "主人" }
}
```

> `master.users` 是**主人**的 QQ 号；`telegram.masterUserId` 是**主人**的 TG id。
> 私聊一律回应；群里只在被 `@` 或命中触发词时才说话。

### 3. QQ（OneBot / NapCat）

1. 装 [NapCat](https://github.com/NapNeko/NapCatQQ)，让它以 **OneBot 11 正向 WebSocket** 暴露
2. 配置里指过去：

```json
{
  "transport": "onebot",
  "onebot": { "url": "ws://127.0.0.1:3001", "token": "你的 OneBot token" }
}
```

3. `node qq-bot/bot.mjs`，日志里出现 `已连接 OneBot` 就通了

### 4. Telegram

1. 找 [@BotFather](https://t.me/BotFather) 建 bot，把 token 存进 `qq-bot/telegram-token.txt`
2. `telegram.pollSeconds` 是**长轮询窗口**：默认 **3 秒**（原因见[设计选择](#几个设计选择-和为什么)）
3. 首次给它发一条消息，日志会打出你的 TG id，把它填进 `telegram.masterUserId`

### 5. 换模型（可选）

```json
{ "llm": { "provider": "ollama", "ollama": { "baseUrl": "http://127.0.0.1:11434", "model": "qwen2.5:14b" } } }
```

`provider` 是**运行时可切**的（面板里改，立刻生效，不用重启）。

### 6. 控制面板（可选）

```bash
node qq-bot/tools/panel-server.mjs      # 默认 http://127.0.0.1:6182
```

---

## 配置参考

配置分**两层**：`src/config.mjs` 里是默认值，`config.json` 只覆盖你要改的键。
**只有 `config.json` 会热重载**；`transport` 是启动时建好的对象，改它要重启。

| 段 | 管什么 | 常见的键 |
| --- | --- | --- |
| `transport` | 用哪个传输层 | `"onebot"` / `"telegram"` / 自定义 |
| `onebot` | QQ 传输 | `url`、`token`、`reconnectMs`、`maxReconnectMs` |
| `telegram` | TG 传输 | `enabled`、`tokenFile`、`masterUserId`、`pollSeconds`、`voiceName`、`voiceRate` |
| `master` | 谁是主人 | `users`、`alias`、`address`、`title`、`romantic` |
| `whitelist` | 谁能用它 | `users`、`groups`、`trigger` |
| `llm` | 模型 | `provider`、`system`（人格正文）、`timeoutMs`、`deepseek.*`、`ollama.*`、`memesFile` |
| `chat` | 说话方式 | `bubbles`（一条回复分几个气泡）、`delayMs`、`replyJitterMs`、`quoteBack`、`findImage` |
| `tools` | 工具循环 | `enabled`、`maxRounds`（默认 **20**）、`enabledTools`（空 = 全开） |
| `stickers` | 表情包目录 | `dir` |
| `voice` | 语音 | `enabled`、`character`、`maxPerReply`、`minIntervalMs` |
| `chatArchive` | 聊天归档 | `dir`、`mediaDir`、`spoolDir`（网络盘暂存）、`ttlDays`（**0 = 永久**）、`recallDays` |
| `memory` | 长期记忆 | 事实库、日记、称呼 |
| `tone` | 语气层 | `vibe`、`bratEveryN` |
| `proactive` | 主动消息 | 间隔、时段、上限 |
| `approvals` | 高风险动作审批 | 哪些要点头 |
| `phone` | 玩手机（实验） | `enabled`、`adb`、`ld`、`serial`、`play.maxSteps`、`play.budgetTokens` |

---

## 目录与文件职责

```text
qq-bot/
├── bot.mjs                 # 主程序：消息处理、工具循环、prompt 组装、发消息
├── package.json            # 零依赖，node >= 22
├── src/
│   ├── config.mjs          # 默认配置 + 覆盖合并 + 热重载
│   ├── llm.mjs             # 模型调用、工具循环（createToolChat）、重试
│   ├── tools.mjs           # 22 个工具的声明与实现，runTool
│   ├── intents.mjs         # 意图路由：能用代码确定性执行的，就不麻烦模型
│   ├── telegram.mjs        # TG 传输：长轮询、发消息、下载媒体
│   ├── onebot.mjs          # QQ 传输：WebSocket、CQ 码解析
│   ├── chatlog.mjs         # 聊天归档：按天/小时写 jsonl、检索、摘要
│   ├── assoc.mjs           # 联想记忆：部位×症状识别 + 归档回查 + 组织提示
│   ├── phone.mjs           # ADB 操作模拟器（只认 emulator-*，永不碰真机）
│   ├── phoneplay.mjs       # "自己玩一会儿"：预算/步数/时间三重上限
│   ├── stickers.mjs        # 表情包解析、工具标记剥除、回复分段
│   ├── addressing.mjs      # 称呼与语气（人格的"怎么说"）
│   ├── memory.mjs          # 事实库 / 日记 / 归档摘要
│   ├── proactive.mjs       # 主动消息调度
│   ├── surf.mjs            # "冲浪"：自己刷内容，挑值得说的
│   ├── video.mjs           # ffmpeg 抽帧 + 拼图
│   ├── tts.mjs             # SAPI 语音合成
│   └── …                   # bilibili / pixiv / imagesearch / music / watch / zip …
├── tools/
│   ├── selftest.mjs        # 自测套件（800+ 断言，零依赖）
│   ├── panel-server.mjs    # 控制面板
│   ├── win-control.ps1     # 窗口截图/控制（PowerShell + P/Invoke，物理像素）
│   └── check-undefined.mjs # 静态检查：未定义变量 / 语法
└── docs/                   # 设计笔记
```

**运行时产物（都不入库）**：`logs/`（按天滚动）、`stickers/`（图库）、`config.json`、`sessions.json`、
`小笛记忆-spool/`（归档暂存）、以及归档根目录（默认 `D:/小笛记忆`）。

---

## 一条消息的旅程

```text
QQ/TG 事件
  → 合并同一个人连发的几条（1.2 秒窗口）
  → 归档：先落盘（jsonl），失败也不耽误回话
  → 意图路由（能确定的直接执行）：
       音量 / 媒体 / 提醒 / 发说说 / 改签名 / 截图 / 退群 …
  → 组装给模型的输入：
       · 图片 → 视觉模型描述
       · 视频 → ffmpeg 抽帧 → 拼图 → 描述
       · B站 链接 → 自动读字幕/弹幕/画面
       · 联想记忆 → 他提到身体/情绪/生活 → 翻旧话（带日期）
  → 工具循环（最多 20 轮）：模型要工具 → 执行 → 结果塞回 → 再问
  → 回复处理：
       剥工具标记（`[[图:]]` 之外的写法一律丢弃）
       剥"写成文本的工具调用"（DSML 漏网的兜底）
       表情包 / 语音 / 网图 分段
       按气泡切分 + 随机停顿（别像打字机）
  → 发送（失败重试；一段失败不影响其它段）
  → 归档记录发出内容
```

---

## 几个设计选择，和为什么

**① 能用代码确定的，就别交给模型**
"把音量调到 30"、"提醒我 10 分钟后喝水"、"发个说说"——这些用正则判定后**直接执行**，
模型只负责复述。反过来，**代码层直接执行的判据必须从严**：曾经"继续啊"被判成"播放"，
代码就去按了系统媒体键，把用户正在办的事整个打断 —— 所以现在光说"继续"不算数，必须有媒体上下文。

**② `tools.maxRounds` 用 20，不用默认的 4**
一轮 = 一次模型回复（可含多个工具调用）。"看一眼 → 点一下 → 再看一眼 → 再点"最少 6~8 轮；
手机任务实测要 8~14 轮。4 轮时她会**被强制作答**，表现为"画面没上来"然后就停了。
代价：20 轮约 8~12 万 token。

**③ 联想记忆放在代码层**
模型不会主动想起"该去翻旧账"。所以由代码在每条消息进模型前先查：命中"部位×症状"就去归档搜，
带上日期塞进提示。**成本 0 token**（本地扫盘），没命中话题时连盘都不扫。

**④ 表情包那段提示放在系统提示的最末尾**
模型对"最后看到的东西"最敏感。原来它后面还跟着工具清单和梗库，于是它一次都没用过表情包。

**⑤ 长轮询 3 秒**
不是"怕超时"，是实测**当前代理节点约 5 秒就掐连接**：`getMe` 5.0 秒 ECONNRESET、
`getUpdates(timeout=1)` 3.5 秒正常。3 秒能活，10 秒必死。

**⑥ 玩手机只认 `emulator-*`**
真机的 serial 长得像 `10AFBS3EQB0049G`。曾经因为"取第一台在线设备"误操作到真机上，
所以现在硬编码只接受 `emulator-<数字>` / `127.0.0.1:<端口>`，配置里写死真机也拒绝。

---

## 自测

```bash
node qq-bot/tools/selftest.mjs        # 802 条断言
node qq-bot/tools/check-undefined.mjs  # 静态检查
```

零依赖、纯 Node：起本地 mock 服务（OneBot / TG / 模型），跑**真实的**消息链路，
然后断言**日志、副作用、发出的内容**——而不是断言"函数返回值好看"。

写断言的两个纪律：

- **不写死日期**。曾经有一条归档断言把日期写成 `10-09 / 10-10`，过了几天它自己红了，
  而代码一行没改。凡是"今天/昨天/窗口 N 天"都用相对 `now` 算。
- **改完必须回读**。替换脚本静默不生效（锚点差一个字），比报错更贵。

---

## 踩过的坑

> 这几条都是真踩出来的，不是抄的。

- **Windows 上 `.ps1` 必须存 UTF-8 带 BOM**。Windows PowerShell 5.1 读无 BOM 的脚本按 GBK 解，
  中文注释能把整份脚本撑成语法错误——而且是**一行都不跑**、连报错都看不到的那种失败。
- **GUI 自动化一律用物理像素坐标**（per-monitor DPI-aware）。DPI-unaware 进程看到的是虚拟坐标，
  而 `GetWindowRect`、鼠标注入走的是物理像素；混用会系统性偏移（本机 2560×1600 @150%，比值 1.5）。
- **从受限进程里注入键鼠会静默失效**。低级完整性进程的 `SendInput` 被 UIPI 丢掉，返回值照样"成功"。
- **Unity 游戏没有无障碍节点**：`uiautomator dump` 返回 **0 个元素**（整块画布一个节点都没有），
  只能靠截图 + 网格读坐标。
- **别用整图哈希判断"画面变了没"**。游戏界面有待机动画，每一帧都不同；实测点空白也报"有变化"。
  正确做法：缩到 64×36 逐格比，变化格子 >2% 才算界面真的变了（实测 空白 0.09% / 真跳页 84%）。
- **模型会把工具调用写成正文**。DeepSeek 偶尔把 `<||DSML|| calls>` 这类标记直接吐进 `content`，
  于是用户收到一串乱码。要在发送前统一剥掉（本项目在 `splitReply` 的最前面做）。
- **`.gitignore` 是白名单不是保险箱**。密钥、cookie、`config.json`、聊天日志、图库一律不进库；
  提交前用 `git grep` 查一遍身份信息，比"我觉得没问题"可靠。

---

## 状态与限制

**稳定在跑**：双传输、记忆归档、联想记忆、表情包、语音、识图/视频、工具循环、控制面板。

**实验性**：玩手机。卡在「Unity 画面没有无障碍节点」这条硬限制上，靠「截图 + 200px 网格 + 帧比对」硬撑。
现在能看、能点、能知道点没点中，但**多步任务（比如配队）还不可靠**。

**明确的"不做"**：

- 不下载/转发受版权保护的音乐（"账号不是问题，用途才是"）
- 不碰支付、不抽卡、不花用户的钱（这条写进了提示词和工具实现里）
- 不碰真实手机（ADB 只认模拟器）

---

## 许可

个人项目，未标许可证。用到的第三方数据（表情包、B站内容等）版权归各自作者。
