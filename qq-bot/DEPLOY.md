# NapCat 部署与运维

## 目录

```
qq-bot/
├── napcat/
│   ├── NapCat.Shell.zip          # 官方包（28MB）
│   ├── shell/                    # 解压后的 NapCat 本体
│   │   ├── config/
│   │   │   ├── napcat.json       # NapCat 自身设置
│   │   │   ├── onebot11.json     # ← 已配好：本机 3001 端口开正向 WebSocket
│   │   │   └── webui.json        # WebUI 端口与随机 token
│   │   └── cache/qrcode.png      # 登录二维码（每次启动刷新）
│   ├── 启动NapCat.cmd            # ← 双击这个
│   ├── start-napcat.ps1          # 实际逻辑（自动提权）
│   ├── stop-napcat.ps1           # 停掉
│   └── napcat-console.log        # 控制台输出留档
├── bot.mjs                       # 机器人
└── tools/mock-onebot.mjs         # 协议端替身（自测用）
```

## 首次部署（已完成，留档备查）

1. 下载 `NapCat.Shell.zip` —— 走 `node tools/fetch-napcat.mjs`，因为本机 `curl.exe` 和 .NET 的
   TLS 是坏的（`SEC_E_NO_CREDENTIALS`），只有 Node 的 HTTPS 能用。
2. 解压到 `napcat/shell/`。
3. 本地 QQ 需 **build ≥ 40768**。本机 `D:\QQ` 是 `9.9.25-42941`，达标。
4. 写好 `napcat/shell/config/onebot11.json`（正向 WS，`127.0.0.1:3001`）。

## 每次启动

**双击 `napcat\启动NapCat.cmd`** → UAC 点「是」→ 等二维码出现。

二维码同时存在于：

- 控制台里的 ASCII 二维码
- `napcat\shell\cache\qrcode.png`
- 解码后的链接（形如 `https://txz.qq.com/p?k=...`）

扫码后 WebUI 的 token 会刷新一次，新 token 会发到**机器人号自己的私聊**里，控制台也会打印新版
`http://127.0.0.1:6099/webui?token=xxxxxxxx`。

用登录后新 token 打开 WebUI：`http://127.0.0.1:6099/webui?token=<token>`。

## 两个必踩的坑（都实测过）

### 1. 必须管理员权限，否则 QQ 静默退出

非提升权限运行时，NapCat 的 DLL 注入会被 QQ 的保护机制挡住，表现是：

```
[NapCat Backend] Process resumed
Process exited.
```

**QQ 秒退、且一个日志文件都不写**。这是最难查的一类失败——没有任何报错指向真正原因。
诊断方法是做对照实验：单独启动 `D:\QQ\QQ.exe`，QQ 活得很好 → 那就说明问题在注入环节，
而不是 QQ 本身。加上管理员权限后立刻成功（NapCat.Core 4.18.30 完整加载）。

### 2. 不要从 DSH 的工具调用里启动它

DSH 的工具进程结束时，它拉起的整棵进程树会被回收。实测：这里启动成功后，
端口 6099 正常监听、二维码已生成，但工具调用一结束，QQ 主进程和 `NapCatWinBootMain.exe`
就一起消失了。所以**用 `启动NapCat.cmd` 手工启动**，让它挂在资源管理器下面，
与任何自动化会话解耦。

## 安全

- `onebot11.json` 里 `host` 写的是 `127.0.0.1`，**只监听本机**。
- 不要把 3001 或 6099 端口映射到公网。真要暴露，必须在 NapCat 侧配 token，
  同时机器人侧 `config.json` 填同一个 token。
- NapCat 官方提醒：**避免在同一 IP／设备上同时登录机器人号和常用号**，
  否则常用号可能被连带风控。这也是"给小号单独用"的另一个理由。

## 常见故障对照

| 症状 | 多半是 |
| --- | --- |
| QQ 秒退、无任何日志 | 没用管理员权限启动 |
| 控制台没有 `WebUi User Panel Url` | 6099 被占；NapCat 会自动 +1 找可用端口，看日志实际端口 |
| 登录后很快掉线 | 账号被风控，或 `o3HookMode` 冲突；见 `napcat.json` 的 `o3HookMode` |
| 机器人收不到消息 | 3001 没监听 / `onebot11.json` 的 `enable` 是 false / 机器人没连上 |
| 机器人连上但收不到 | 跑 `node tools/selftest.mjs` 先排除自己代码的问题 |

## 卸载

删掉整个 `qq-bot/napcat/` 目录即可，NapCat 不在系统里留任何东西，也不影响 QQ 的更新与卸载。
`stop-napcat.ps1` 用来清掉残留的 QQ 进程。
