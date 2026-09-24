# OpenClaw arXiv Daily

通过微信指令订阅研究方向，每天接收 arXiv 新论文的英文 abstract、可选中英文概括和链接。支持独立的多人订阅，默认北京时间 **08:00** 开始处理。

A small, self-hosted arXiv digest plugin for OpenClaw Weixin, with per-user topics and optional Chinese or English summaries.

**实验版本 0.1.1**。适配目标：Windows、Node 24、OpenClaw **2026.9.6**、腾讯微信插件 **2.4.8**。这是社区项目，不是腾讯或 OpenClaw 官方插件。已通过 18 项离线行为测试，并验证真实 arXiv API 的读取和解析；**尚未完成 Windows Gateway 加载、真实模型认证及微信收件的端到端验证**。

## 能做什么

- 每人独立设置方向、概括语言、暂停状态；最多 50 个订阅条目。
- 每篇保留英文原始 abstract，附 arXiv 页面和 PDF 链接。
- 可选约 200 字中文或约 200 词英文概括，包含研究空白、工作、方法、结论；也可关闭概括。
- 概括只依据 abstract，不声称阅读全文；同一论文的同语言概括共用缓存。
- 按每人已发送的 arXiv 基础编号去重，不因 v2/v3 更新重复推送。
- 确定性解析 `/arxiv` 指令；插件生效期间，微信普通文本不会启动 AI 对话。
- 使用已有 OpenClaw agent 的模型与认证，不需要在本插件中填写额外 API key。
- SQLite 保存订阅、任务与发送状态；后台调度使用插件服务。

## 支持哪些学科？

**方向没有天文学限制，但目前数据源只有 arXiv。** 换关键词不会自动接入其他论文库。

| 方向 | 本版本覆盖情况 |
| --- | --- |
| 天文、物理、数学、统计 | 可订阅 arXiv 上相关论文 |
| 计算机、机器学习、计算机视觉 | 可订阅 arXiv 上相关论文 |
| 医学影像、医学 AI、医学物理 | 可订阅发表在 arXiv 上的相关论文 |
| 临床医学、药物试验等完整医学文献跟踪 | 仅靠 arXiv 不足，需要增加 PubMed 等数据源 |

**PubMed、medRxiv、bioRxiv 尚未接入。** 例如订阅 `lung cancer` 只会匹配 arXiv 上相关内容，不代表覆盖肺癌领域的新研究。范围可参见 [arXiv 学科分类](https://arxiv.org/category_taxonomy) 和 [PubMed 简介](https://pubmed.ncbi.nlm.nih.gov/about/)。

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

默认安装目录：`%USERPROFILE%\.openclaw\local-plugins\arxiv-daily-0.1.1`。如只想先展开检查源码：

```powershell
node "$env:USERPROFILE\Downloads\install-arxiv-daily.cjs" --prepare-only
```

可以加 `--dir "目标目录"`。安装器不会覆盖手工修改过的源码，也不会自动替换其他目录注册的同名插件。已有安装产生冲突时，先核对插件路径并保留修改，不要删除订阅数据库来解决路径问题。原有 cron 维护任务保留。

## 第一次订阅

以下指令发给**微信中的机器人**，不是粘贴到 PowerShell。每次发送一条，等回复后再发下一条。

先订阅：

```text
/arxiv subscribe 21cm, EoR, high redshift
```

再试发一篇：

```text
/arxiv test
```

每人都要自己发送订阅指令。扫描登录二维码不等于创建日报订阅。

`test` 从最近 7 天内匹配方向、尚未向本人发过的论文中选 1 篇，该篇计入已发送记录。首次可能需要几分钟；没有匹配论文时结果为 0，不会编造论文。用 `/arxiv status` 查看进度，以手机实际收件为准。

## 微信命令速查

所有订阅命令只作用于发送者本人的记录。

| 微信指令 | 作用 |
| --- | --- |
| `/arxiv help` | 查看帮助 |
| `/arxiv subscribe 21cm, EoR, high redshift` | 创建订阅，或**替换全部方向** |
| `/arxiv subscribe` | 使用管理员配置的默认方向订阅 |
| `/arxiv add JWST, cosmic dawn` | **追加方向**，保留已有方向 |
| `/arxiv remove high redshift` | 删除指定方向；不能删除最后一个方向 |
| `/arxiv topics` | 查看当前方向 |
| `/arxiv lang zh` | 约 200 字中文概括 |
| `/arxiv lang en` | 约 200 词英文概括 |
| `/arxiv lang none` | 只发送英文 abstract 和链接，不生成概括 |
| `/arxiv test` | 试发 1 篇未发送的近期论文 |
| `/arxiv now` | 立即处理本人尚未发送的近期论文 |
| `/arxiv status` | 查看订阅、最近任务及投递状态 |
| `/arxiv pause` | 暂停本人订阅 |
| `/arxiv resume` | 恢复本人订阅 |
| `/arxiv retry` | 重试微信明确拒绝的消息 |
| `/arxiv retry uncertain` | 核对手机后重试结果不确定的消息，可能重复 |
| `/arxiv unsubscribe` | 删除本程序内本人的订阅与发送记录 |

`test`、`now`、`retry` 的手动请求至少间隔 1 分钟。暂停、退订或修改方向不能撤回已经提交给微信的消息。退订后重新订阅可能再次收到最近一周的论文。

### 不同学科的订阅示例

下列每行都是一种独立用法；连续执行多条 `subscribe` 会替换前一次方向。要增加方向，请用 `add`。

| 需求 | 微信指令 |
| --- | --- |
| 21cm / 再电离 / 高红移 | `/arxiv subscribe 21cm, EoR, high redshift` |
| 检索增强生成 / 联邦学习 | `/arxiv subscribe retrieval augmented generation, federated learning` |
| 计算机视觉 | `/arxiv subscribe image segmentation, object detection` |
| 医学影像 | `/arxiv subscribe medical image segmentation, magnetic resonance imaging` |
| 肺癌 / 肿瘤分割（仅 arXiv） | `/arxiv subscribe lung cancer, tumor segmentation` |

### 关键词如何匹配

- 多个方向用中英文逗号分隔；每人 1–12 个方向，每个最多 70 个字符。
- 方向之间是“或”，匹配论文标题和 abstract；不是语义检索或整个学科的完整订阅。
- 推荐使用具体的英文研究术语。不自动把中文方向翻译为英文。
- 内置三组天文同义写法：`21cm/21 cm/21-cm`、`EoR/reionization/reionisation`、`high redshift/high-redshift/high-z` 等。
- 其他缩写、同义词、单复数目前不自动扩展；有需要时分别添加。
- 尚不支持按 `cs.AI` 等 arXiv 分类代码订阅，也不接受布尔检索表达式。
- 太宽的关键词可能超过每次查询的结果上限；程序会明确报告错误，不把截断结果当作完整日报。

## 一篇日报包含什么

1. 论文标题、作者、arXiv 编号、首次提交日期和匹配方向。
2. 原始英文 abstract。
3. 可选概括：**研究空白 / 做了什么 / 怎么做的 / 结论**。
4. 论文页面和 PDF 链接。

概括仅根据 abstract。摘要未交代的信息会说明未交代，不用猜测补齐。长消息会按微信文本限制拆成多段，保留完整 abstract。

## 每天 08:00 如何运行

- 默认 `08:00 Asia/Shanghai` **开始处理**，逐篇发送。生成概括、联网及排队都会影响实际抵达时间。
- 首次订阅在当天 08:00 之后，首个自动任务安排在次日；可以先用 `test` 或 `now`。
- 电脑需开机、联网、保持唤醒，且 Gateway 正常运行。
- 调度器属于本插件后台服务，**不会新增 `openclaw cron list` 条目**。Heartbeat、Memory Dreaming、Skill review 是其他维护任务。
- 默认回看最近 7 天首次提交的论文，按每个用户的基础编号去重。首次订阅可能补发最近一周内容；超过 7 天的停机缺口不会自动全量补齐。
- 没有匹配新论文时不发送空日报。arXiv 索引出现延迟时，论文可能到后续日报才出现。
- 查询按日缓存；请求串行，间隔至少 3 秒。同一天已经缓存的查询不会持续刷新。
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

[config.example.json](config.example.json) 只展示插件配置片段，**不要用它覆盖完整的 `openclaw.json`**。`sendTime`、`timeZone`、`lookbackDays` 等是管理员的全局设置；当前没有 `/arxiv time` 或切换数据源的微信指令。

## 先用两个账号验收，再扩到 50 人

1. 两人订阅不同方向，分别查看 `/arxiv topics`，确认互不影响。
2. 分别设置 `zh` 和 `en` 并试发，核对手机上的完整 abstract、概括、链接及实际收件人。无匹配论文时用状态确认 0 篇。
3. 普通“你好”应无 AI 回复；`/arxiv help` 应正常回复。
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

18 项离线测试覆盖多用户隔离、普通聊天拦截、SQLite 持久化、北京时间调度、概括缓存、分页、去重、不确定发送及退订等行为。它们不会调用真实模型或向微信发消息。

安装包由明确列出的源码文件构建，包含 SHA-256 校验；`check:installer` 检查安装包与当前源码是否一致。修改源码或 README 后请重新构建。安装流程目前只适配 Windows，未验证 Linux/macOS 部署；OpenClaw 插件接口为实验接口，暂时保持目标版本。

欢迎按 [CONTRIBUTING.md](CONTRIBUTING.md) 提交修改。使用 [MIT License](LICENSE)。`package.json` 中的 `private: true` 只用于避免误发 npm，不影响本仓库代码的开源许可。

## 本地数据与参考

默认数据库位于 `%USERPROFILE%\.openclaw\arxiv-daily\state.sqlite`；配置备份位于状态目录的 `arxiv-daily-backups`。数据库、配置、凭据、日志、二维码信息都不应上传到公开仓库。

本插件没有遥测或额外服务端。检索关键词会发送给 arXiv，论文标题与 abstract 会发送给已配置的模型服务；OpenClaw 和微信适配器的日志按其自身配置保存。

- [OpenClaw 插件 hooks](https://docs.openclaw.ai/plugins/hooks)
- [OpenClaw 模型运行时](https://docs.openclaw.ai/plugins/sdk-runtime/models)
- [OpenClaw 插件安装](https://docs.openclaw.ai/cli/plugins/install)
- [arXiv API 手册](https://info.arxiv.org/help/api/user-manual.html)
- [腾讯微信插件](https://github.com/Tencent/openclaw-weixin)
