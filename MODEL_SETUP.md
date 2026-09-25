# 模型接入

运行 `node install-arxiv-daily.cjs --configure-model`，与首次安装使用同一菜单：

1. 保留当前模型。
2. ChatGPT／OpenAI。
3. Claude／Anthropic。
4. DeepSeek。
5. Gemini／Google。
6. 其他 OpenClaw 服务商。

选择服务商后，可登录／填写密钥，也可使用已有认证；随后从 OpenClaw 刷新的可用文本模型列表选择。只有能识别为可用的模型会进入列表，未找到时停止并提示登录，不偷偷改用另一家。

## 接入方式

- **ChatGPT／OpenAI**：可选 ChatGPT 浏览器登录、设备码登录或 OpenAI API key。前两者使用宿主支持的 ChatGPT/Codex 登录流程；API key 使用 OpenAI Platform API 额度。不能把此网页会话的登录直接当成通用 API key，也不复制聊天中的凭证。账号是否可用由实际登录结果决定。[OpenAI 认证说明](https://learn.chatgpt.com/docs/auth)。
- **Claude**：快速入口使用 Anthropic API key，直接交给 OpenClaw 的 `api-key` 登录方法。[获取密钥](https://platform.claude.com/settings/keys)。已有其他受支持的 Claude 登录配置，可以保留当前模型或在选择 Claude 后跳过重新登录。
- **DeepSeek**：快速入口使用 DeepSeek API key；缺少官方 provider 插件时，通过 OpenClaw 原生安装流程安装并固定解析版本。[获取密钥](https://platform.deepseek.com/api_keys)。
- **Gemini**：快速入口使用 Google AI Studio API key。[获取密钥](https://aistudio.google.com/apikey)。
- **其他**：填写已经由 OpenClaw 支持并配置好的 provider ID，使用其原生认证流程。

不把聊天订阅视为任意 API 的免费额度；不同认证方式的可用模型与用量规则由服务商决定。安装器不会代付费用、创建付费订阅或把密钥写进公开仓库。

## 切换后的行为

设置只针对日报所选 agent；模型目录条目按需补入，不覆盖其他模型配置。显式选择模型时将这个 agent 的候选回退列表设为空，避免出错后自动换到未选择的模型。若该 agent 也被你用于别的任务，那些任务会沿用同一个模型设置。

主模型来自 OpenClaw 的实时／本机发布目录；仓库没有固定某个 GPT、Claude、DeepSeek 或 Gemini 型号。目录显示可用不等于已经实测生成，安装后用微信 `/arxiv test` 验证一篇。长论文要多次调用模型；过小的上下文窗口可能不适合，失败会报告而不会截断正文后冒充已读全文。

已经发送的论文不会因切换模型重新推送。旧的概括和阅读笔记保留；新生成的概括使用当前模型。模型认证异常可重新运行本菜单登录，原订阅方向不会清空。
