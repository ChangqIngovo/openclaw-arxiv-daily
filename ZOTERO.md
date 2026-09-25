# 每个人自己的 Zotero 文献库

从 0.4.0 起，可以在微信里选择把**已经收到的日报论文**保存到本人 Zotero 的个人文献库和指定 Collection。不同微信订阅者分别授权、选择文件夹；本功能不操作群组文献库。

收藏包括文献条目、可用的阅读概括子笔记，以及可点击的 arXiv PDF 链接。**这一版保存 PDF 链接，不上传 PDF 文件附件。** 收藏不会重新调用模型；笔记使用这次日报实际生成的内容和版本。较早的已收日报也能主动收藏，这不改变日报只发送前一个自然日新论文的规则。

## 管理员：一次性部署

### 1. 更新插件

在 Windows PowerShell 下载本仓库的安装器，运行 `node 安装器路径 --upgrade`。原有订阅、发送记录和数据库保留。Zotero 默认关闭，配置完成后才启用。

### 2. 发布授权回调网页

仓库已提供 [zotero-callback.html](zotero-callback.html) 和 [src/zotero-callback.js](src/zotero-callback.js)。这是一个静态页面：显示一次性授权完成指令，供用户复制回微信。不需要为 Windows Gateway 开放公网端口。

在 [仓库 Pages 设置](https://github.com/ChangqIngovo/openclaw-arxiv-daily/settings/pages) 中选择：

1. **Source → Deploy from a branch**。
2. **Branch → main**，目录 **/(root)**，点击 Save。
3. 等待部署完成，再打开：

```text
https://changqingovo.github.io/openclaw-arxiv-daily/zotero-callback.html
```

直接打开时提示“没有收到有效授权结果”是正常的；这一步只检查网页能否访问。不要把 `raw.githubusercontent.com` 的源码地址当作回调网页地址。

也可以把 HTML 和 `src/zotero-callback.js` 放在自己的 HTTPS 网站上，保持相对目录，并在下面配置中填写实际地址。公开分发的 fork 应使用自己控制的回调站点。

### 3. 注册 Zotero OAuth 应用

管理员登录 [Zotero 应用注册页面](https://www.zotero.org/oauth/apps)，为这个日报服务注册一个应用，例如 **arXiv Daily**。网站地址可以填写本仓库地址，Callback URL 填写第 2 步实际部署的 HTTPS 回调页面地址。

取得 **Client Key** 和 **Client Secret**。这是日报服务的应用凭据，每个订阅者仍需单独授权自己的个人库。不要使用管理员个人文献库的 API Key 作为全体订阅者的授权。

### 4. 在 Windows 本机配置

使用刚下载的安装器：

```powershell
node $ArxivInstaller --configure-zotero
```

程序会交互询问 Client Key、Client Secret；Secret 隐藏输入。默认回调是本仓库的 Pages 地址。自己部署网页时指定：

```powershell
node $ArxivInstaller --configure-zotero --callback-url "https://your-domain.example/zotero-callback.html"
```

配置脚本从 OpenClaw 查询真实插件路径，不依赖安装目录中的旧版本号。它把应用凭据和生成的加密主密钥存入 `%USERPROFILE%\.openclaw\arxiv-daily\zotero-app.json`（使用 `OPENCLAW_STATE_DIR` 时遵循该目录），限制文件访问权限，然后启用配置并重启 Gateway。OpenClaw 的公开插件配置只保存开关与凭据文件路径。脚本遵循本机正常 PowerShell 执行策略。

已有加密主密钥会保留，**不要删除、重建或把该文件提交到 GitHub**。备份或迁移时，凭据文件和 `arxiv-daily/state.sqlite` 必须配套保留。配置脚本发现已有授权但主密钥缺失时会停止，防止使其他人的授权无法解密。

若 Gateway 重启超时，使用 `openclaw gateway status` 检查实际状态；超时本身不表示 Gateway 一定停止。Zotero 配置文件不可读或无效时，原日报仍可使用，日志会提示 Zotero 未就绪。

### 5. 在自己的微信做完整验证

按下一节完成绑定并收藏一篇已收论文，随后在自己的 Zotero 在线库和已开启同步的客户端检查条目、文件夹、笔记和 PDF 链接。

## 每个订阅者：绑定并收藏

所有指令都发给微信中的日报机器人，每次一条。

```text
/arxiv zotero connect
```

机器人返回 Zotero 官方授权链接。打开链接，登录**自己的** Zotero，授权个人文献库读取、笔记和写入权限。授权完成后，网页会显示一条 `/arxiv zotero finish ...` 指令；复制并发回申请绑定的**同一个微信会话**。15 分钟后过期，可以重新 connect。密码只在 Zotero 官网输入；不需要向机器人发送密码或长期 API Key。

收到“已绑定”后查看文件夹：

```text
/arxiv zotero folders
```

选择一个文件夹。名称唯一时可以写名称；重名时必须使用列表显示的八位编号或完整路径：

```text
/arxiv zotero folder EoR
```

文件夹需要先在 Zotero 中创建并同步。也可以用 `/arxiv zotero folder root` 保存到个人文献库根目录。

对感兴趣的日报论文发送，例如：

```text
/arxiv save 2609.30003
```

等待“已收藏”，或查看：

```text
/arxiv zotero status
```

| 指令 | 作用 |
| --- | --- |
| `/arxiv zotero` | 查看 Zotero 指令 |
| `/arxiv zotero connect` | 开始个人授权 |
| `/arxiv zotero finish …` | 使用网页生成的一次性指令完成绑定 |
| `/arxiv zotero folders 2` | 查看文件夹列表第 2 页 |
| `/arxiv zotero folder 名称或编号` | 更改本人默认保存位置 |
| `/arxiv save arXiv编号` | 收藏已收到的论文；可以收藏较早日报 |
| `/arxiv zotero status` | 查看本人绑定和最近操作结果 |
| `/arxiv zotero disconnect` | 清除本机保存的本人授权并取消待处理操作 |

更换 Zotero 账号前先 disconnect。解绑不会删除已经收藏的文献。彻底撤销 Zotero 端的访问权限，请在 [Zotero API Key 设置](https://www.zotero.org/settings/keys) 中删除本应用授权。`/arxiv unsubscribe` 同时删除本机的本人 Zotero 绑定、待处理任务和阅读快照。

## 去重、失败与边界

- 同一篇按 arXiv 基础编号去重。优先复用个人库中已存在的匹配条目；有多个候选时让用户先合并，不猜测。添加到新文件夹会保留原有文件夹。
- 已有文献的标题、作者和手写笔记不覆盖。本插件已经创建的阅读笔记也不会因为再次收藏而覆盖用户修改。
- 文献、笔记、PDF 链接分步写入。失败时可能已经完成部分步骤；重新发送同一收藏指令会先核对现有条目，再继续缺失步骤。只有所有所需步骤核对成功才回复“已收藏”。
- 新建条目使用固定条目编号和 `version: 0` 创建前提，阻止重试覆盖已有对象；修改 Collection 使用版本检查，并合并最新列表。
- 已删除或进入回收站的条目、文件夹发生冲突时，会提示用户处理。程序不自动删除、清空或恢复文献库内容。
- 解绑或取消能阻止后续请求，已经发出的网络写入仍可能完成。微信通知发送不确定时不会自动重复通知，结果保存在 `/arxiv zotero status`。
- 收藏不抓取任意旧论文，只接受已经发给本人的日报编号。升级前旧消息可从发送记录恢复笔记；若缓存元数据已换成不同版本，则明确提示用原文链接手动导入。
- Zotero 授权粒度是个人文献库，不能理解为 API Key 只允许某一个 Collection。插件在代码中把操作限定在本人选择的收藏与文件夹；每个 API 请求都使用本人的授权和个人库路径。
- 授权数据在 SQLite 中按订阅者分别加密，客户端密钥保存在 Windows 本地受限文件中。机器人运营者控制这台机器，因此这不是对运营者隐藏文献库访问能力的方案；其他订阅者不能通过指令读取你的凭据或收藏状态。

## 验证情况

新增离线测试覆盖 OAuth 签名、用户间授权隔离、过期与重放、凭据加密、文件夹重名与分页、保存去重、已有元数据与笔记保留、并发修改、部分成功、网络超时、解除绑定、重启恢复及旧版本快照。

已核对 Zotero 官方接口文档、官方 Connector 的 OAuth 请求实现，以及公开 preprint 条目模板。**尚未使用真实个人授权完成 Zotero 写入，也未在 Windows 执行本版配置脚本；需按上面的步骤进行首次联调。** 既有日报的 Windows 手动收件已经在 0.3.1 验证，不能代替 Zotero 联调或 50 人持续运行验证。

参考：[OAuth](https://www.zotero.org/support/dev/web_api/v3/oauth)、[写入与 Collection](https://www.zotero.org/support/dev/web_api/v3/write_requests)、[权限核对及版本](https://www.zotero.org/support/dev/web_api/v3/syncing)、[Zotero 同步](https://www.zotero.org/support/sync)、[GitHub Pages 发布源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。
