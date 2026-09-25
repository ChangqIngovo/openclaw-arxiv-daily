# Zotero 个人收藏

每个人在自己的电脑配置自己的 Zotero。收到日报不会自动保存；只有发送 `/arxiv save 编号` 才会收藏。

## 本机配置

1. 用自己的 Zotero 账号打开 [创建个人 API key](https://www.zotero.org/settings/keys/new)。名称可填 `arXiv Daily`；允许个人文献库读取、笔记及写入。本功能不需要群组库或文件上传权限。
2. 运行下载的安装器，添加 `--configure-zotero`。密钥只填在本机的隐藏输入提示中。
3. 向导读取实际账号信息和文件夹，选择保存位置。若需要新文件夹，先在 Zotero 创建并同步，再运行配置。

Windows：

```powershell
node "$env:USERPROFILE\install-arxiv-daily.cjs" --configure-zotero
```

macOS：

```bash
node "$HOME/install-arxiv-daily.cjs" --configure-zotero
```

不需要 OAuth Client Key、Client Secret、GitHub Pages 或回调网页。此前已有有效的 OAuth 绑定，升级会保留；需要更换时运行上述向导即可。

## 微信中选论文

```text
/arxiv zotero status
/arxiv save 2609.30003
```

每篇日报末尾有对应收藏命令，复制感兴趣的那一条发回助手。只能保存已发给自己的论文，可收藏以前收过的日报；这不会扩大每天的新论文范围。

换文件夹：

```text
/arxiv zotero folders
/arxiv zotero folder EoR
```

重名时用列表中的八位文件夹编号；子文件夹可用完整路径。`/arxiv zotero folder root` 选择文献库根目录。

## 保存什么

- 论文题名、作者、abstract、固定版本的 arXiv 链接等元数据。
- 可用的四项概括阅读笔记。
- PDF 网络链接，不是下载后上传 PDF 文件。

重复收藏会复用能明确识别的条目，不覆盖已有题名或手写笔记。加入不同文件夹时保留原来的归属。请求返回不确定时先核对服务器，避免盲目创建重复条目。Zotero 桌面端同步后可见。

## 解除与本地数据

`/arxiv zotero disconnect` 删除本地绑定、取消等待中的收藏。已发出的请求可能仍完成；已经收藏的文献保留。若要使 key 在 Zotero 端失效，到 [API key 设置](https://www.zotero.org/settings/keys) 删除对应 key。

个人 key 加密保存在本机 SQLite 中；加密密钥在 `arxiv-daily/zotero-app.json`。macOS 使用用户文件权限，Windows 写入前限制为当前用户和 SYSTEM。能够控制本机的程序或管理员仍可能访问这些凭证；这不等同于系统钥匙串。恢复备份需保留数据库和匹配的密钥文件。

API key 的写入授权覆盖个人库，Zotero 不提供“仅此文件夹”的 API key 权限；程序按你选择的收藏位置工作。个人版只允许安装时验证的微信账号操作，不提供他人远程接入。

参考：[Zotero API](https://www.zotero.org/support/dev/web_api/v3/basics) · [权限验证](https://www.zotero.org/support/dev/web_api/v3/syncing) · [写入规则](https://www.zotero.org/support/dev/web_api/v3/write_requests)。
