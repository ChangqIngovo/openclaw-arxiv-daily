# OpenClaw arXiv Daily

通过微信指令订阅研究方向，每天接收**前一个自然日首次提交**的 arXiv 论文： abstract、**阅读正文后**生成的可选概括和链接，支持个人关键词优先级，默认北京时间 **08:00** 开始处理。

## 能做什么

- 每人独立设置方向、**P1、P2、P3…关键词优先级**、概括语言和暂停状态；最多 50 个订阅条目。
- 新匹配论文先按个人优先级排列，同一优先级按首次提交日期从新到旧；多关键词命中只发一次。
- 每篇保留 abstract，附 arXiv 页面和 PDF 链接。
- 可选约 200 字中文概括，包含研究空白、工作、方法、结论；也可关闭概括。
- 每次只筛选前一个自然日，默认按北京时间；首次订阅、试发、重试也不扩大日期范围。
- 按每人已发送的 arXiv 基础编号去重，不因 v2/v3 更新重复推送。
- 确定性解析 `/arxiv` 指令；插件生效期间，微信普通文本不会启动 AI 对话。
- 使用已有 OpenClaw agent 的模型与认证，不需要在本插件中填写额外 API key。
- SQLite 保存订阅、任务与发送状态；后台调度使用插件服务。
- 可选 Zotero 个人库收藏：每人独立授权、选择文件夹，把感兴趣的已收论文、阅读笔记及 PDF 链接保存到自己的库。


| 学科 | 关键词示例 | 当前数据范围 |
| --- | --- | --- |
| 天文 | `21cm cosmology`、`EoR`、`high redshift`、`JWST` | arXiv 上的天体物理、宇宙学等相关论文 |
| 物理 | `quantum entanglement`、`superconductivity`、`magnetic reconnection` | arXiv 上的量子、凝聚态、等离子体等相关论文 |
| 化学 | `quantum chemistry`、`molecular dynamics`、`catalysis` | arXiv 收录的化学物理、计算化学等相关论文 |
| 计算机 | `retrieval augmented generation`、`federated learning`、`computer vision` | arXiv 上的计算机科学和机器学习等相关论文 |
| 生物 | `protein folding`、`gene regulation`、`population dynamics` | arXiv 收录的定量生物学、生物物理等相关论文 |

**当前数据源只有 arXiv。** 化学和生物示例不代表覆盖这两个学科的全部文献；ChemRxiv、bioRxiv、medRxiv、PubMed 均尚未接入。arXiv 的具体覆盖范围见其[学科分类说明](https://arxiv.org/category_taxonomy)。

## 安装前准备

你需要已经安装并配置好 OpenClaw、一个能正常调用模型的 agent，以及腾讯微信通道。默认 agent 名为 `arxiv_bot_v1`，也可在安装时用 `--agent` 指定已有 agent。

在 **PowerShell** 检查：

```powershell
openclaw agent --agent arxiv_bot_v1 --message "只回复 OK，不调用任何工具。"
openclaw channels status --channel openclaw-weixin --probe
```

记录微信登录输出中的 **bot accountId**；它不是个人微信号，也不是收件人的 userId。本安装器不会代你登录微信或创建 agent。模型用量与计费沿用该 agent 已有配置。

## 安装到 Windows

下载仓库中的 [install-arxiv-daily.cjs](install-arxiv-daily.cjs) 到下载目录。把下面的 `YOUR_BOT_ACCOUNT_ID` 替换为自己的 bot accountId，再在 **PowerShell** 运行：

```powershell
node "$env:USERPROFILE\Downloads\install-arxiv-daily.cjs" --account "YOUR_BOT_ACCOUNT_ID" --agent "arxiv_bot_v1"
```

如果已经登录两个微信连接，重复传入 `--account`：

```powershell
node "$env:USERPROFILE\Downloads\install-arxiv-daily.cjs" --account "YOUR_FIRST_BOT_ACCOUNT_ID" --account "YOUR_SECOND_BOT_ACCOUNT_ID" --agent "arxiv_bot_v1"
```

公开安装包不包含任何个人账号 ID。安装器会展开可读源码、安装锁定依赖、运行测试、备份配置，然后通过 OpenClaw 的正常插件安装与启用流程完成配置。过程中会停止并重新启动 Gateway。OpenClaw 可能要求审阅本地插件来源或能力；按其正常提示处理，安装器不绕过授权检查。

默认安装目录：`%USERPROFILE%\.openclaw\local-plugins\arxiv-daily-0.4.0`。如只想先展开检查源码：

```powershell
node "$env:USERPROFILE\Downloads\install-arxiv-daily.cjs" --prepare-only
```

可以加 `--dir "目标目录"`。安装器不会覆盖手工修改过的源码，也不会自动替换其他目录注册的同名插件。已有安装产生冲突时，先核对插件路径并保留修改，不要删除订阅数据库来解决路径问题。原有 cron 维护任务保留。

## 已有安装：在 PowerShell 更新到 0.4.0

已装过本项目 0.1.0、0.1.1、0.2.0、0.3.0、0.3.1 或 0.3.2 时，运行下面的命令。只在 GitHub 更新 README 不会自动更新你电脑上的插件。

```powershell
$ArxivInstaller = Join-Path $env:TEMP "install-arxiv-daily-0.4.0.cjs"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/ChangqIngovo/openclaw-arxiv-daily/main/install-arxiv-daily.cjs" -OutFile $ArxivInstaller -ErrorAction Stop
node $ArxivInstaller --upgrade
```

更新器从 OpenClaw 查询实际加载目录，核对已有源码、备份配置与将替换的文件，停止 Gateway，再原地更新、运行测试并启动 Gateway。它保留现有账号、agent、订阅方向、概括语言、暂停状态和发送记录；原有方向顺序仍作为 P1、P2、P3…，不重置数据库。旧的 `lookbackDays: 7` 会改为 `1`；运行时也固定使用前一个自然日，旧缓存不会扩展日期范围。旧的 abstract 概括缓存不用于新生成的概括。

如果源码有手工修改，更新器会停止并指出文件，不覆盖这些修改。更新中途失败时，先处理错误；若 Gateway 已停止，安装器会明确提示。备份位置会打印在 PowerShell 中。`--upgrade` 不自动安装缺失插件；第一次安装请用上面的 `--account` 命令。

### 从 Windows PDF 测试失败中恢复

0.3.0 在 Windows 上把 PDF.js 的字体和 CMap 目录写成了以反斜杠结尾的路径；PDF.js 要求这些目录以 `/` 结尾，因此 PDF 解析会在初始化时失败。0.3.1 将资源路径统一为正斜杠，仍由 Node 从本地读取，并在本地测试错误中保留原始解析异常。

如果上一轮输出 `PDF 无法完整提取文本`、`Cannot read properties of undefined (reading 'format')`，随后提示 Gateway 已停止，直接下载上面的 **0.4.0 安装器并重跑 `--upgrade`**。已展开的 0.3.0 源码及新旧版本混合的中断状态均可核对后继续升级；原来的配置、订阅和发送记录保留。无需删除 `arxiv-daily-0.1.0` 等旧名称目录，程序会从实际注册位置原地更新。

安装器会在测试通过后继续配置和启动 Gateway。仍未通过时会保留具体原因，不跳过测试。回归测试在当前执行环境中重现 Windows 盘符及 UNC 路径，调用真实 PDF.js 验证初始化，并检查本地资源可读；这不等于已经验证所有 Windows 运行环境。

更新后检查：

```powershell
openclaw plugins inspect arxiv-daily --runtime --json
openclaw gateway status
```

检查插件运行时信息是否加载成功，然后在微信里发送 `/arxiv status` 核对实际日期范围，再用 `/arxiv test` 试发。无需重新订阅；`/arxiv lang zh` 或 `en` 现在均读取正文后概括。现有安装目录可能仍包含旧版本号，这是原地更新的正常结果，以目录内 `package.json` 的版本和实际命令行为为准。

## 收藏到每个人自己的 Zotero

Zotero 默认关闭。管理员先发布仓库自带的静态回调网页、注册一个 Zotero OAuth 应用，再在 Windows 本机运行：

```powershell
node $ArxivInstaller --configure-zotero
```

完整部署、个人授权、文件夹选择及失败恢复步骤见 **[ZOTERO.md](ZOTERO.md)**。应用配置完成后，每个订阅者在自己的微信会话中使用：

```text
/arxiv zotero connect
/arxiv zotero folders
/arxiv zotero folder EoR
/arxiv save 2609.30003
/arxiv zotero status
```

每次一条，等待完成再执行下一条；connect 后先按官方授权网页提示，将一次性完成指令发回微信。重名文件夹用八位编号选择。收藏按 arXiv 基础编号去重，可收藏较早收到的日报，使用当时的论文版本和概括，不重新调用模型。保存的是 **PDF 链接**，本版不上传 PDF 文件。每个微信订阅者只能使用自己的 Zotero 个人库授权。

## 第一次订阅

以下指令发给**微信中的机器人**，不是粘贴到 PowerShell。每次发送一条，等回复后再发下一条。

先订阅：

```text
/arxiv subscribe 21cm cosmology, EoR, high redshift, JWST
```

再试发一篇：

```text
/arxiv test
```

每人都要自己发送订阅指令。扫描登录二维码不等于创建日报订阅。

`test` 从前一个自然日首次提交、匹配方向且尚未向本人发过的论文中，按优先级和日期选 1 篇，该篇计入已发送记录。读取长论文可能需要几分钟或更久；没有匹配论文时结果为 0，不会编造论文。用 `/arxiv status` 查看进度，以手机实际收件为准。

## 微信命令速查

所有订阅命令只作用于发送者本人的记录。

| 微信指令 | 作用 |
| --- | --- |
| `/arxiv help` | 查看帮助 |
| `/arxiv subscribe 21cm cosmology, EoR, high redshift, JWST` | 按输入顺序创建订阅，或**替换全部方向及其优先级** |
| `/arxiv priority 1 21cm cosmology` | 把已有的 21cm 方向移到第 1 位，其余方向顺移 |
| `/arxiv priority 2 JWST` | 把已有的 JWST 方向移到第 2 位，其余方向顺移 |
| `/arxiv priority` | 查看当前优先级 |
| `/arxiv subscribe` | 使用管理员配置的默认方向订阅 |
| `/arxiv add JWST, cosmic dawn` | 在**优先级末尾追加方向**，保留已有顺序 |
| `/arxiv remove high redshift` | 删除指定方向；不能删除最后一个方向 |
| `/arxiv topics` | 查看当前方向和 P1、P2、P3…顺序 |
| `/arxiv lang zh` | 读正文后生成约 200 字中文概括 |
| `/arxiv lang en` | 读正文后生成约 200 词英文概括 |
| `/arxiv lang none` | 只发送英文 abstract 和链接，不生成概括 |
| `/arxiv test` | 按优先级试发前一日首次提交且尚未发送的 1 篇 |
| `/arxiv now` | 立即处理前一日首次提交且本人尚未发送的论文 |
| `/arxiv status` | 查看订阅、最近任务及投递状态 |
| `/arxiv zotero` | 查看个人 Zotero 绑定、文件夹选择及收藏指令 |
| `/arxiv save arXiv编号` | 把已收到的论文收藏到本人 Zotero；需先完成授权与文件夹设置 |
| `/arxiv pause` | 暂停本人订阅 |
| `/arxiv resume` | 恢复本人订阅 |
| `/arxiv retry` | 重试当前前一日范围内微信明确拒绝的消息 |
| `/arxiv retry uncertain` | 核对手机后重试当前前一日范围内结果不确定的消息，可能重复 |
| `/arxiv unsubscribe` | 删除本程序内本人的订阅与发送记录 |

`test`、`now`、`retry` 的手动请求至少间隔 1 分钟。暂停、退订或修改方向不能撤回已经提交给微信的消息。退订后重新订阅可能再次收到当前前一日范围内的论文，不会因此扩大到最近一周。

### 关键词优先级怎么设置

订阅时，逗号左侧的关键词优先级更高。例如：

```text
/arxiv subscribe 21cm cosmology, EoR, high redshift, JWST
```

| 优先级 | 方向 |
| --- | --- |
| P1（最高） | 21cm cosmology（归一化显示为 `21cm`） |
| P2 | EoR |
| P3 | high redshift |
| P4 | JWST |

`21cm cosmology` 是内置 `21cm` 方向的别名，会匹配 `21cm`、`21 cm`、`21-cm` 等写法，不要求 abstract 恰好出现完整的 “21cm cosmology” 短语。`cosmology` 单独列为另一个关键词则是独立、更宽泛的方向。

日报先列所有新的 P1 论文，再列 P2、P3、P4；同一级内部按首次提交日期从新到旧，日期相同按 arXiv 编号排序。若当天 P1 没有匹配结果，直接从有结果的下一优先级开始；较低优先级论文仍然会推送。同一篇同时匹配 P1 和 P3，只在 P1 位置发一次，并列出全部命中方向。

日后无需重新订阅，只移动一个已有方向即可。例如让 JWST 排第二：

```text
/arxiv priority 2 JWST
```

结果为 `P1: 21cm → P2: JWST → P3: EoR → P4: high redshift`。序号必须在当前方向数量范围内，未知方向先用 `/arxiv add` 添加。`add` 放在末尾，`remove` 删除后自动压紧编号；重复添加已有方向不会改变它的位置。

每人的排序独立，不改变其他人的优先级。改变顺序不会把已发送的论文再发一遍。优先级决定**新匹配论文的展示及发送顺序**，不代表 arXiv 返回相关性分数；底层查询仍批量执行并共享缓存。仍在当前日期范围内、已生成但尚未发完的消息先续传，手动重试沿用原消息内容；更早的消息不续传，优先级调整不会重写已提交的消息。已经开始发送的旧版消息可能保留旧版概括格式。

### 五类学科的订阅命令

下面每行是一位用户的独立示例，关键词从左到右为 P1、P2、P3…。连续发送多条 `subscribe` 会替换前一次设置。

| 学科 | 微信指令 |
| --- | --- |
| 天文 | `/arxiv subscribe 21cm cosmology, EoR, high redshift, JWST` |
| 物理 | `/arxiv subscribe quantum entanglement, superconductivity, magnetic reconnection` |
| 化学 | `/arxiv subscribe quantum chemistry, molecular dynamics, catalysis` |
| 计算机 | `/arxiv subscribe retrieval augmented generation, federated learning, computer vision` |
| 生物 | `/arxiv subscribe protein folding, gene regulation, population dynamics` |

### 关键词如何匹配

- 多个方向用中英文逗号分隔；每人 1–12 个方向，每个最多 70 个字符。
- 方向之间是“或”，命中后按最高优先级归类，匹配论文标题和 abstract；不是语义检索或整个学科的完整订阅。
- 推荐使用具体的英文研究术语。不自动把中文方向翻译为英文。
- 内置三组天文同义写法：`21cm/21 cm/21-cm`、`EoR/reionization/reionisation`、`high redshift/high-redshift/high-z` 等。
- 其他缩写、同义词、单复数目前不自动扩展；有需要时分别添加。
- 尚不支持按 `cs.AI` 等 arXiv 分类代码订阅，也不接受布尔检索表达式。
- 太宽的关键词可能超过每次查询的结果上限；程序会明确报告错误，不把截断结果当作完整日报。

## 一篇日报包含什么

1. 最高匹配优先级（如 `P1 · 21cm`）、论文标题、作者、arXiv 编号、首次提交日期和全部匹配方向。
2. 原始英文 abstract。
3. 可选概括：**研究空白 / 做了什么 / 怎么做的 / 结论**。
4. 论文页面和 PDF 链接。

概括依据论文正文文本，覆盖引言、方法、结果、讨论/结论和能够提取的附录；保留研究局限及数值限定，不用猜测补齐正文未说明的信息。消息会注明正文来源（HTML/PDF）、PDF 页数（如适用）、阅读分段数和固定版本链接。长消息会按微信文本限制拆成多段，保留完整 abstract。

### 如何读取论文

1. 先请求与元数据版本对应的 `https://arxiv.org/html/<id>vN`，提取论文主体、标题、公式文本和图表说明，排除网页导航。
2. HTML 缺失或无可用正文时，下载对应 PDF，使用 PDF.js 在独立工作线程中逐页提取文本。
3. 32,000 字符以内的正文直接作为概括依据；更长的正文**全部分段**阅读，先提取各段证据，再综合所有分段生成约 200 字/词的四项概括，不只截取开头。
4. 正文获取失败、某 PDF 页不可提取、超过大小/页数上限时，消息明确标为“未生成正文概括”，只保留原始英文 abstract 和链接。**不会用 abstract 概括冒充正文概括。**

这是正文**文本**阅读，不是对 PDF 版面的视觉审稿。图像本身不做视觉解读；图注和可提取的表格文本会进入输入，复杂公式、表格布局仍可能解析有误。模型生成内容也需要读者核对原文。arXiv 的 HTML 转换存在覆盖和渲染限制，见[官方说明](https://info.arxiv.org/about/accessible_HTML.html)。

当前上限为 HTML 10 MB、PDF 30 MB/300 页、提取文本 48 万字符；超限不会静默截断后宣称已读全文。PDF 解析最多 60 秒。正文失败缓存 30 分钟，避免多人订阅重复请求；成功正文按论文编号和版本缓存，分段笔记也共享，同语言最终概括复用。长论文首次生成会增加模型调用次数和处理时间，后续同论文同语言订阅无需重复生成。

`/arxiv lang none` 不下载正文、不调用模型。已经发出“未生成正文概括”的论文仍计入发送记录，当前没有单篇重新生成或追加概括指令。

## 每天 08:00 如何运行

- 默认 `08:00 Asia/Shanghai` **开始处理**，逐篇发送。生成概括、联网及排队都会影响实际抵达时间。
- 首次订阅在当天 08:00 之后，首个自动任务安排在次日；可以先用 `test` 或 `now`。
- 电脑需开机、联网、保持唤醒，且 Gateway 正常运行。
- 调度器属于本插件后台服务，**不会新增 `openclaw cron list` 条目**。Heartbeat、Memory Dreaming、Skill review 是其他维护任务。
- **固定筛选前一个自然日 00:00（含）至当天 00:00（不含）首次提交的论文**，时区使用 `timeZone`，默认北京时间。例如 2026-09-25 08:00 仅处理 2026-09-24 00:00–24:00，即 UTC 的 2026-09-23 16:00 至 2026-09-24 16:00（不含）。
- “新”按 arXiv API 的 `published`（首次版本提交时间）判断，不按 `updated`、期刊出版日期或每日 announcement 批次判断。老论文新发 v2/v3 不因更新而成为当天新论文。
- 首次订阅、`test`、`now` 和 `retry` 均使用同一日期范围；旧队列、旧缓存和停机恢复不触发历史补发。跨日时停止旧日期任务，已经提交的消息无法撤回。
- 没有匹配新论文时不发送空日报，也不扩大窗口凑数。arXiv 在处理后才提供可检索元数据；索引延迟、休刊/周末或停机可能导致符合提交日期的论文未及时可见。**严格不补历史意味着可能漏掉迟到论文**，不承诺覆盖官方每个公告批次。
- 查询按日缓存；元数据与正文下载请求串行，共用至少 3 秒的请求间隔。同一天已经缓存的查询不会持续刷新。
- 抓取或概括失败后，最多在 15 分钟和 30 分钟后再试两次。发送失败单独记录，不自动重发结果不明的消息。

**“已提交”只表示微信接口返回消息 ID，不表示手机已显示或已读。** 发送时超时或进程中断会记为“不确定”，核对手机后才使用 `retry uncertain`。已成功提交的前面段落不会再次提交。

## 普通聊天与账号范围

本插件的聊天拦截作用于**同一 Gateway 的全部 `openclaw-weixin` 入站消息**，不是只作用于 `allowedAccountIds` 中的账号。只有允许列表中的账号可以操作日报订阅；其他微信连接的普通 AI 聊天也会被拦截。建议让日报使用专门的 Gateway。

普通文本由 `before_dispatch` 接管，另有 `before_agent_run` 后备拦截。订阅指令确定性解析，不交给模型。摘要通过 OpenClaw 官方 `runtime.llm.complete` 的隔离模式调用，工具数为零，订阅数据库不进入概括上下文。

腾讯适配器自身的 `/echo`、`/toggle-debug`，以及 OpenClaw 的快速停止、审批指令可能在本插件之前处理。机器人不会接管你个人微信与其他好友的聊天。

停用或未成功加载本插件后，OpenClaw 原有对话逻辑可能恢复。上线前请发送普通的“你好”验证无 AI 回复，再发送 `/arxiv help` 确认指令能正常处理。

收件人只从可信微信通道上下文取得，不从指令文字或模型输出指定；不同账号与收件人的订阅记录独立。

## 管理员命令（PowerShell）

| 命令 | 作用 |
| --- | --- |
| `openclaw gateway status` | 查看 Gateway 状态 |
| `openclaw gateway start` | 启动 Gateway |
| `openclaw gateway stop` | 停止整个 Gateway，包括其他服务 |
| `openclaw plugins inspect arxiv-daily --runtime --json` | 检查日报插件是否加载 |
| `openclaw channels status --channel openclaw-weixin --probe` | 检查微信连接 |
| `openclaw agents bindings --agent arxiv_bot_v1` | 检查账号到 agent 的路由 |

新增用户时，先通过腾讯微信插件完成其微信连接登录，再把登录输出中的 bot accountId 加入日报：

```powershell
node "$env:USERPROFILE\Downloads\install-arxiv-daily.cjs" --add-account "YOUR_NEW_BOT_ACCOUNT_ID"
```

安装器保留已有允许列表，增加账号路由并重启 Gateway。随后新用户在自己的微信中发送 `/arxiv subscribe ...`。登录二维码不是供多人反复扫描的永久加好友码。

[config.example.json](config.example.json) 只展示插件配置片段，**不要用它覆盖完整的 `openclaw.json`**。`sendTime`、`timeZone` 等是管理员的全局设置；`lookbackDays` 仅保留旧配置兼容，运行时固定为前一个自然日；当前没有 `/arxiv time` 或切换数据源的微信指令。

## 先用两个账号验收，再扩到 50 人

1. 两人订阅不同方向，分别查看 `/arxiv topics`，确认互不影响。
2. 分别设置 `zh` 和 `en` 并试发，核对手机上的完整 abstract、正文概括及来源标注、链接、日期范围和实际收件人。无匹配论文时用状态确认 0 篇。
3. 分别设置不同优先级，检查收到的论文是否先 P1 再 P2，同级由新到旧；普通“你好”应无 AI 回复，`/arxiv help` 应正常回复。
4. 重启 Gateway，再执行 `now`，检查设置保留且已提交论文不重复。
5. 两人至少连续 48 小时不发新指令，观察有匹配新论文时是否仍能自动收到日报。

若发送错误包含 `prepare failed/context token`，先由该微信发送 `/arxiv status` 刷新会话，再尝试 `/arxiv retry`。如果必须每天发消息才能收件，该通道就不能满足完全无人值守的日报要求，需要更换投递通道；定时器不能绕过服务端限制。

50 是程序的订阅条目上限，**不是 50 人稳定性实测结论**。通道连接限制、主动投递能力及模型额度仍需在实际部署中确认。

## 开发与开源

使用 Node 24：

```sh
npm ci --ignore-scripts --omit=dev --omit=peer
npm test
npm run build:installer
npm run check:installer
```

39 项离线测试覆盖日期边界、夏令时、缓存/重试/跨日限制、HTML/PDF 正文提取、长论文末尾证据、失败标注、个人优先级、多用户隔离、概括缓存、分页、去重、不确定发送，以及旧版本升级检查等行为。它们不会调用真实模型或向微信发消息。

安装包由明确列出的源码文件构建，包含 SHA-256 校验；`check:installer` 检查安装包与当前源码是否一致。修改源码或 README 后请重新构建。安装流程目前只适配 Windows，未验证 Linux/macOS 部署；OpenClaw 插件接口为实验接口，暂时保持目标版本。

欢迎按 [CONTRIBUTING.md](CONTRIBUTING.md) 提交修改。使用 [MIT License](LICENSE)。`package.json` 中的 `private: true` 只用于避免误发 npm，不影响本仓库代码的开源许可。

## 本地数据与参考

默认数据库位于 `%USERPROFILE%\.openclaw\arxiv-daily\state.sqlite`；配置备份位于状态目录的 `arxiv-daily-backups`。数据库、配置、凭据、日志、二维码信息都不应上传到公开仓库。

本插件没有遥测或额外服务端。检索关键词会发送给 arXiv，选择概括时，论文标题、abstract、提取的正文及分段阅读笔记会发送给已配置的模型服务；OpenClaw 和微信适配器的日志按其自身配置保存。

- [OpenClaw 插件 hooks](https://docs.openclaw.ai/plugins/hooks)
- [OpenClaw 模型运行时](https://docs.openclaw.ai/plugins/sdk-runtime/models)
- [OpenClaw 插件安装](https://docs.openclaw.ai/cli/plugins/install)
- [PDF.js](https://mozilla.github.io/pdf.js/)
- [arXiv API 手册](https://info.arxiv.org/help/api/user-manual.html)
- [腾讯微信插件](https://github.com/Tencent/openclaw-weixin)
