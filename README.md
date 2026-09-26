# OpenClaw arXiv Daily · 个人版

每天用微信接收感兴趣的 arXiv 新论文：abstract、阅读全文后生成的中／英文概括、原文链接。按关键词或分类的优先级排列，可手动收藏到自己的 Zotero。

**默认跟随电脑时区，每天当地时间 08:00 开始，只取前一个自然日首次提交的论文。**

## 安装与升级

先安装 [Node.js 24.16+](https://nodejs.org/en/download)（推荐 24 LTS），重新打开终端，再运行：

**Windows · PowerShell**

```powershell
Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/ChangqIngovo/openclaw-arxiv-daily/main/install-arxiv-daily.cjs" -OutFile "$env:USERPROFILE\install-arxiv-daily.cjs"
node "$env:USERPROFILE\install-arxiv-daily.cjs"
```

**macOS · Terminal**

```bash
curl -fsSL https://raw.githubusercontent.com/ChangqIngovo/openclaw-arxiv-daily/main/install-arxiv-daily.cjs -o "$HOME/install-arxiv-daily.cjs"
node "$HOME/install-arxiv-daily.cjs"
```

按向导连接自己的微信，设置关键词或分类代码，选择 **ChatGPT／OpenAI、Claude、DeepSeek 或 Gemini** 及具体模型。Zotero 可选。

**升级也运行上面的命令**，保留原有订阅和发送记录。完成后在微信发送 `/arxiv test` 试发一篇，`/arxiv status` 查看状态。

## 常用指令（在微信聊天框输入）

| 指令 | 作用 |
| --- | --- |
| `/arxiv subscribe 21cm cosmology, astro-ph.CO, astro-ph.GA` | 关键词和分类可混排，从左到右优先级递减 |
| `/arxiv add JWST` | 添加方向到末尾 |
| `/arxiv priority 1 JWST` | 把已有方向移到第一位 |
| `/arxiv lang zh` | 中文概括；`en` 英文；`none` 仅 abstract |
| `/arxiv test` | 试发前一天未发过的 1 篇 |
| `/arxiv now` | 重新查询前一天的论文，只发尚未发送的 |
| `/arxiv status` | 查看订阅、当前时区和任务状态 |
| `/arxiv save 4321.12345` | 收藏指定的已收论文到 Zotero（编号仅示例） |
| `/arxiv help` | 查看全部指令，包括暂停、恢复和删除方向 |

分类支持 `astro-ph.CO`、`cs.AI`、`quant-ph` 等，也可写成 `cat:astro-ph.CO`；包含交叉分类，同篇只发一次。

试发也计入已发送，日报不会重复发送；没有待发论文时会收到“没有新论文”通知。电脑需要开机、联网且未休眠。普通聊天不会启动 AI 对话；论文不会自动收藏。

[更换模型](MODEL_SETUP.md) · [连接 Zotero](ZOTERO.md) · [详细规则与排错](DETAILS.md) · [开发](CONTRIBUTING.md)
