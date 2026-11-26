# Hermes ChatGPT 定时队列 · Hermes ChatGPT Queue

[简体中文](#简体中文) · [English](#english)

## 简体中文

在 Hermes Desktop 里，把当前 ChatGPT 草稿排到指定时间，或等下一个已验证的 5 小时额度窗口再发。插件把计划绑定到原本地 profile、会话和模型：切换到另一个会话不会改变投递目标。

### v3.0.1 更新

修复长工具回合后的额度续跑漏判。入队和到点发送前都会翻页核对最近的用户消息；如果已有新消息或无法完整核对，就不自动续跑。已有安装只需替换 `plugin.js`。

### 能做什么

- **定时发送**：写好纯文字草稿，点输入框旁的日历按钮，设定 1–1,440 分钟内的发送时间。提交队列成功后才清空原输入框。
- **下个额度窗口发送**：用输入框旁的循环箭头，把草稿安排到 Hermes 报告的短窗口重置时间后约 1 分钟。如果重置时间无法确认，保留原草稿。
- **额度恢复后续跑**：插件启用后，新队列默认开启自动续跑，可在状态栏「ChatGPT 队列」暂停。只对已核实的 `openai-codex` 5 小时额度耗尽安排续跑。它在原会话追加继续提示，不是重新发送原始请求；周额度耗尽、普通限流或账号池归属不明不会触发自动续跑。
- **取消和恢复**：输入框上方会显示当前会话的待处理消息。取消时可把文字放回空草稿；遇到草稿冲突可保留计划、删除计划，或选择记入本地取消日志。现有草稿带附件时不提供覆盖。

### 安装

1. 打开 Hermes Desktop 的 **Capabilities → Plugins**（部分版本显示为 **Settings → Plugins**），点击 **Open folder** 找到桌面插件目录。
2. 在该目录创建 `chatgpt-window-queue`，放入此仓库的 [`plugin.js`](plugin.js)，得到 `desktop-plugins/chatgpt-window-queue/plugin.js`。不需要 Node 包安装、编译或修改 Hermes 本体。
3. 在插件列表打开「ChatGPT 定时队列」的桌面开关（默认关闭）。如果没有出现，可在命令面板运行 **Reload desktop plugins**。在使用 `openai-codex` 的本地会话中检查输入框旁的按钮；状态栏可打开总队列。

### 兼容性与注意事项

- **v3.0.1 为纯文字版，界面目前是中文。** 有图片、文件或内联引用的草稿会保留在输入框，不会入队；斜杠命令请正常发送。多输入框或布局无法确认时，回到单会话视图再试。
- 需要支持原生草稿 SDK、本地 profile 路由和 `hermes-gateway-v1` 投递的 Hermes Desktop；不适用于网页端、CLI 或远程 profile。未指定最低版本号。插件通过只读的输入框标记探测附件，桌面布局升级后建议先用测试草稿验证。
- 这是桌面队列，不是服务器 cron。到点时若应用退出或休眠跨过截止时间，不会静默补发。无明确接收回执的任务需先核对原会话；「Hermes 已接收」不是模型已完成。
- 待发正文保存在本地 IndexedDB；主动选择「删除并留日志」会在插件数据目录另存正文。投递使用 Hermes 的原会话、模型与工具权限，不代为批准请求；启用跳过审批的会话不会被队列投递。续跑会使用现有 ChatGPT 额度，不会增加额度。

### 开发验证

```sh
node --check plugin.js
node --test queue.test.mjs
```

测试使用模拟 SDK 和网关，不向 ChatGPT 发送消息；覆盖路由、额度判定、长工具回合后的分页续跑、附件拒绝、取消恢复和重启后的重复发送防护。插件可独立安装，测试文件不需要放进插件目录。参见 [Hermes Desktop Plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk)。

## English

Queue a ChatGPT draft in Hermes Desktop for a specific time or the next verified five-hour usage window. Each job stays bound to its original local profile, conversation, and model, even if you switch to another chat before it runs.

### What changed in v3.0.1

Fixed missed auto-resume after long tool-heavy turns. Before queueing and again before sending, the plugin pages through the transcript to verify the latest user message. It does not auto-resume if a newer message exists or verification is incomplete. To upgrade an existing installation, replace `plugin.js`.

### Features

- **Schedule a draft:** write a plain-text draft, click the calendar next to the composer, and pick a time 1–1,440 minutes out. The original composer clears only after the draft is queued.
- **Send after the next window resets:** use the circular-arrow button. The plugin schedules the draft about one minute after the short-window reset reported by Hermes. If the reset cannot be verified, the draft stays in the composer.
- **Resume after quota exhaustion:** once the plugin is enabled, auto-resume is on by default for new queue state. Pause it from the **ChatGPT 队列** status item. Auto-resume requires corroborated `openai-codex` five-hour quota exhaustion and sends a continuation prompt in the original chat rather than replaying the original request. Weekly exhaustion, generic throttling, and ambiguous account pools do not trigger it.
- **Cancel or recover:** pending items appear above the composer. Cancel to return text to an empty draft; if there is a conflict, you can keep or delete the job, or save a local cancellation log. A draft with attachments is never offered for replacement.

### Install

1. In Hermes Desktop, open **Capabilities → Plugins** (or **Settings → Plugins** on some builds) and choose **Open folder** to find the desktop plugin folder.
2. Create a `chatgpt-window-queue` folder there and copy [`plugin.js`](plugin.js) into it. The resulting path is `desktop-plugins/chatgpt-window-queue/plugin.js`. No dependency installation, build, or Hermes application patch is needed.
3. Enable the desktop toggle for **ChatGPT 定时队列** in the Plugins list; it is off by default. If it does not appear, run **Reload desktop plugins** from the command palette. In a local `openai-codex` chat, check for the composer buttons; use the status item to see the entire queue.

### Compatibility and caveats

- **v3.0.1 is text-only and currently has a Chinese UI.** Drafts with images, files, or inline references stay in the composer. Use normal send for slash commands. Return to a single-chat view if the plugin cannot identify the composer unambiguously.
- Requires Hermes Desktop with the native composer SDK, local profile routing, and `hermes-gateway-v1` prompt delivery. The web dashboard, CLI, and remote profiles are outside its scope. No minimum version is specified. Since attachment preflight reads composer markers without modifying them, test with a disposable draft after major desktop UI updates.
- This is a desktop queue, not a server-side cron job. If the app is closed or sleep crosses a deadline, missed jobs are not silently replayed. If delivery is uncertain, inspect the original chat before acting. Hermes acknowledging a prompt does not mean the model has finished it.
- Pending text is stored locally in IndexedDB. Choosing to save a cancellation log writes the text into the plugin's local data folder. Delivery uses the original chat's tool permissions, does not approve requests, and refuses chats with approval bypass enabled. Auto-resume uses the existing ChatGPT quota; it does not increase it.

### Development checks

```sh
node --check plugin.js
node --test queue.test.mjs
```

The tests mock the SDK and gateway; they do not send messages to ChatGPT. They cover routing, quota decisions, paged auto-resume after long tool turns, attachment refusal, draft recovery, and duplicate-send protection across restarts. Only `plugin.js` is needed at runtime. See the [Hermes Desktop Plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk).
