# OpenClaw arXiv Daily · 个人版

在自己的 Windows 或 Mac 上运行，用微信接收 **前一个自然日首次提交**的 arXiv 论文：abstract、阅读正文后生成的可选概括和链接。关键词按 P1、P2、P3…排列，默认北京时间 **08:00** 开始处理。

每个人独立安装，连接自己的微信、模型和 Zotero。只收藏你选择的论文。

## 安装

先安装 [Node.js 24.16+](https://nodejs.org/en/download)（24 LTS 推荐），然后重新打开终端。已有符合要求的 Node 可以直接继续。

**Windows：在 PowerShell 复制运行**

```powershell
Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/ChangqIngovo/openclaw-arxiv-daily/main/install-arxiv-daily.cjs" -OutFile "$env:USERPROFILE\install-arxiv-daily.cjs"
node "$env:USERPROFILE\install-arxiv-daily.cjs"
```

**macOS：在 Terminal 复制运行**

```bash
curl -fsSL https://raw.githubusercontent.com/ChangqIngovo/openclaw-arxiv-daily/main/install-arxiv-daily.cjs -o "$HOME/install-arxiv-daily.cjs"
node "$HOME/install-arxiv-daily.cjs"
```

安装向导会：

1. 检测 OpenClaw；首次安装时在用户目录安装并打开官方登录向导。
2. 安装微信插件，让你用自己的微信扫码；已有连接可直接选择。
3. 设置个人收件人、关键词与默认每天 08:00 的任务。
4. 提供 **ChatGPT／OpenAI、Claude、DeepSeek、Gemini** 和其他服务商入口，读取可用模型让你选择；也可保留当前模型。
5. 可选：在本机填写个人 Zotero API key、选择收藏文件夹。

完成后，在微信助手对话中分别发送：

```text
/arxiv status
/arxiv test
```

`test` 只试发前一天、尚未发过的 1 篇。若无符合条件的新论文，用 `status` 看结果。普通聊天不会启动 AI 对话。

版本 **0.5.1**；适配 OpenClaw **2026.9.6**、腾讯微信插件 **2.4.8**。已有其他宿主版本时，安装器会提示，不自动替换。模型登录方式与可用额度以服务商及 OpenClaw 配置为准。

## 从旧版升级

重新运行上面的两条命令即可，也支持 `--upgrade`。你原来的订阅方向、暂停状态、发送记录与 Zotero 绑定会保留。

若之前连接了两个微信，向导让你选择自己的那一个；个人版只处理这个账号的本人消息。其他旧记录留在本机，不再调度。朋友使用时，在朋友自己的电脑安装。

## 选择或更换模型

Windows：

```powershell
node "$env:USERPROFILE\install-arxiv-daily.cjs" --configure-model
```

macOS：

```bash
node "$HOME/install-arxiv-daily.cjs" --configure-model
```

| 接入 | 认证入口 | 模型选择 |
| --- | --- | --- |
| ChatGPT／OpenAI | ChatGPT 浏览器／设备码登录，或 OpenAI API key | 从本机实际可用列表选择 |
| Claude | Anthropic API key | 从本机实际可用列表选择 |
| DeepSeek | DeepSeek API key | 从本机实际可用列表选择 |
| Gemini | Google AI Studio API key | 从本机实际可用列表选择 |
| 其他 | OpenClaw 已支持的服务商 | 输入 provider ID 后选择 |

不在日报代码里写死模型名称；登录与密钥由 OpenClaw 管理。更换时只设置日报所用 agent 的主模型，不修改其他 agent 的主模型。具体入口和说明见 [MODEL_SETUP.md](MODEL_SETUP.md)。

## 微信命令

| 指令 | 作用 |
| --- | --- |
| `/arxiv subscribe 21cm cosmology, EoR, high redshift, JWST` | 替换全部方向；从左到右为 P1、P2、P3、P4 |
| `/arxiv priority 1 21cm cosmology` | 把已有方向移到第 1 位 |
| `/arxiv add JWST` | 在优先级末尾添加 |
| `/arxiv remove high redshift` | 删除方向 |
| `/arxiv topics` | 查看方向及优先级 |
| `/arxiv lang zh` | 中文概括；`en` 英文，`none` 仅 abstract |
| `/arxiv test` | 试发前一日未发过的 1 篇 |
| `/arxiv now` | 处理前一日全部匹配且未发过的论文 |
| `/arxiv status` | 查看订阅和任务状态 |
| `/arxiv pause` / `/arxiv resume` | 暂停／恢复 |
| `/arxiv retry` | 重试当前日期范围内明确发送失败的消息 |
| `/arxiv retry uncertain` | 核对手机后重试结果不确定的消息，可能重复 |
| `/arxiv unsubscribe` | 删除自己的订阅、发送记录和收藏绑定 |
| `/arxiv help` | 完整帮助 |

P1 匹配论文先发，再发 P2、P3…；同一篇只发一次。空缺优先级跳过，不用旧论文补位。`21cm cosmology` 是 `21cm` 的别名。

| 学科 | 关键词示例（从高到低） |
| --- | --- |
| 天文 | `21cm cosmology, EoR, high redshift, JWST` |
| 物理 | `quantum entanglement, superconductivity, magnetic reconnection` |
| 化学 | `quantum chemistry, molecular dynamics, catalysis` |
| 计算机 | `retrieval augmented generation, federated learning, computer vision` |
| 生物 | `protein folding, gene regulation, population dynamics` |

数据源目前只有 arXiv；化学和生物覆盖有限，尚未接入 ChemRxiv、bioRxiv、medRxiv 或 PubMed。

## 只收藏感兴趣的论文

安装时可配置 Zotero，也可之后运行同一安装器，加上 `--configure-zotero`。使用自己的[个人 API key](https://www.zotero.org/settings/keys/new)，在本机填写即可，**无需注册 OAuth 应用或搭建回调网页**。

配置好之后，微信发送：

```text
/arxiv zotero folders
/arxiv zotero folder EoR
/arxiv save 2609.30003
```

这只保存编号 `2609.30003` 的已收论文；其他论文不会自动收藏。保存内容为文献条目、可用概括笔记及 **PDF 链接**，不是上传 PDF 文件。详情见 [ZOTERO.md](ZOTERO.md)。

## 运行与排错

- 推送时电脑需要开机、联网且未休眠。08:00 是开始处理时间，长论文概括需要几分钟。
- 只取配置时区前一个自然日的首次提交；默认 `Asia/Shanghai`，不跟随电脑自动变时区。
- 正文优先 HTML，失败则逐页提取 PDF；正文不可读时不生成概括。标题使用 `Abstract`、`概括`、`summary`。
- Gateway 启动超时不一定代表进程已停止。运行安装器加 `--status` 查看，不要重复删除配置或重装。
- 初次 Node/OpenClaw 安装、登录和微信扫码需要本人完成。本项目不是打包的桌面 App。

更多规则见 [DETAILS.md](DETAILS.md)。这是社区项目；跨平台路径和行为测试不等同于真实账号端到端验收。现有 Windows 环境已验证正文概括微信收件；macOS 首次完整安装、各服务商真实登录、Zotero 真实写入和定时运行仍需实机确认。

## 开发

```bash
npm ci --ignore-scripts --omit=peer
npm test
npm run build:installer
npm run check:installer
```

GitHub Actions 在 Windows 和 macOS 上运行离线测试、安装包一致性检查及源码展开检查；不使用真实账号，也不会发送微信或写入 Zotero。见 [CONTRIBUTING.md](CONTRIBUTING.md)。MIT License。
