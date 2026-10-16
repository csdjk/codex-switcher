# Token 输出速度：方案与验收

> 以下保留开发与本地预览阶段的验收记录；v0.2.19 的安装说明和发布前验证见 [v0.2.19 发布说明](发布说明/v0.2.19.md)。

日期：2026-10-16。工程：`E:\LiChangLong\AI\codex-switcher`。

## GitHub 调研

| 项目 | 可借鉴的部分 | 本次取舍 |
| --- | --- | --- |
| [dongyue-19/codex-statusbar](https://github.com/dongyue-19/codex-statusbar) | 本地 rollout 中的官方输出 token 计数、Reasoning / AgentMessage 时间窗口、两种用量事件去重、无有效时间时不造数 | 参考其公开的测量方法；不引入覆盖窗口、注册表自启动或未公开的 Codex IPC |
| [AndreaZero/codex-usage](https://github.com/AndreaZero/codex-usage) | Rust / Tauri 本地日志监视、增量读取与速度展示 | 复用当前工程已有 React / Tauri 技术栈，不安装额外监控程序 |
| [gsanhueza/pi-token-speed](https://github.com/gsanhueza/pi-token-speed) | 滑动窗口、速度平滑及异常短窗口处理 | 它是 Pi 扩展，不是可直接安装的 Codex 插件；仅参考显示思路，不宣称本地日志可以提供逐 token 流式数据 |

字段另与 [OpenAI Codex protocol.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) 中的 `ItemCompletedEvent`、`TokenUsageRecord` 核对。此次实现为本工程独立新增的 Rust / TypeScript 模块，没有运行第三方仓库程序或导入第三方依赖。

## 使用

账号管理页的账号总览下方新增“Token 输出速度”面板。没有导入账号时也可以读取本机已有的 Codex 会话。

面板显示会话模型、最近有效速度、近期平均速度、该样本的输出 token / 输出时段、记录日期时间。默认自动选择监控列表中最近有记录的会话；下拉框可以固定会话，避免并行项目的数据来回切换。

有两个重要区别：

1. **本地日志推算值，不是逐 token 实时测速。** 页面约每 2 秒检查一次本地数据，但数值只有在有效的模型响应记录出现后才更新。
2. **会话模型不等于当前前台页签或账号绑定模型。** 本次没有连接 Codex 内部 IPC，也没有把会话归属猜测为当前切换账号。模型以日志中的 `turn_context` / 模型重路由记录为准，不用全局配置猜测。

模型名称旁的状态区分等待新样本、近期活动、最近记录和历史记录。最新响应没有有效计时而仍有旧样本时，显示“保留上次有效样本”及原记录时间。切换模型会清空前一模型的速度；读取错误会清空界面数据并自动重试。固定的会话不在列表中时不会自动替换成另一个会话。

## 测量口径

单次速度：

```text
估算 tok/s = 本次官方 output_tokens × 1000
             ÷ 本次 Reasoning / AgentMessage 时间窗口并集长度（毫秒）
```

`reasoning_output_tokens` 已包含在 `output_tokens` 中，不再次相加。只接受模型思考和文本条目的起止时间，不把命令执行、MCP 调用、等待用户操作等条目的时间计入分母；相互重叠的模型时间区间只算一次。

现代 `token_usage_record.usage` 和旧版 `event_msg/token_count.info.last_token_usage` 都支持。同一响应可能在两种载体中出现，因此使用累计计数及 response ID 去重，而不是把两份用量累加。不同响应即使恰好输出相同数量的 token，也不能被误去重。

近期均值是同一会话、同一模型最近 5 次有效响应的加权均值：总输出 token / 总模型时间。不会将不同模型、不同会话、子代理混在一起平均。

**精度边界：** 所有速度均带 `≈`。日志计时精度、工具参数生成未完全落入文本时间窗口等因素会影响估计，尤其不宜把工具调用密集任务的值当作严格解码性能基准。没有原始流式 token 到达时间，无法据此提供真实瞬时速度。输出窗口不足 0.5 秒、初始尾部不完整、负数/无效计数或缺少模型/计时时，不生成新样本。没有有效样本时显示 `--`，不以字符数估算 token。

## 数据与性能边界

- 仅只读 `CODEX_HOME/sessions`，未设置时使用用户目录的 `.codex/sessions`。不读取认证文件或账号密钥，不修改 Codex 配置，不代理网络，不为测速发送模型请求。
- 最多监控最近 8 个主会话。扫描周期 10 秒，候选文件数、遍历深度和扫描条目数有上限；不读取归档会话，跳过内部符号链接与已识别的子代理。
- 初次读取日志尾部 4 MiB，必要时为恢复模型信息扩到最多 16 MiB。后续按偏移量增量读取；保留半行等待后续写入，处理截断及超大行，不重复读取整个历史文件。
- Windows 文件仍被写入进程打开时，文件修改时间可能延迟更新；已纳入监控的会话使用日志事件时间校正活动时间。新进入候选范围的会话仍受文件发现周期及文件系统元数据影响。
- 页面隐藏或离开账号管理页后暂停轮询，恢复可见后重新读取；同一组件内没有重叠请求。
- 前端只收到模型、项目目录末级名称、会话 ID、时间、数值与状态；不返回对话正文、工具参数或认证信息。

## 实现入口

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/token_speed.rs` | 日志解析、去重、时间窗口并集、增量读取、监控缓存和 Tauri 命令 |
| `src-tauri/src/token_speed_tests.rs` | 17 项相关 Rust 测试 |
| `src-tauri/examples/token_speed_snapshot.rs` | 元数据聚合诊断，不主动调用模型 |
| `src-tauri/src/lib.rs` / `web.rs` | 桌面 invoke 与 HTTP 后端命令注册 |
| `src/hooks/useTokenSpeed.ts` | 可见性控制、串行轮询、错误恢复 |
| `src/lib/tokenSpeed.ts` | 类型、会话选择及数字显示 |
| `src/components/TokenSpeedPanel.tsx` | 面板、会话固定及统计说明 |
| `tests/tokenSpeed.test.ts` / `tokenSpeed.browser.cjs` | 前端逻辑与浏览器回归 |

## 已完成验证

- 全部 Rust 单元测试：95 项通过，其中新增速度相关测试 17 项。
- `cargo check --locked --offline --manifest-path src-tauri/Cargo.toml --bins`：通过。
- Windows Release 构建：`codex-switcher` 与 `codex-web` 均通过，桌面端使用 `tauri/custom-protocol` 内嵌最终前端资源。
- `tests/tokenSpeed.backend.ps1`：运行实际后端进程并调用 HTTP 命令，通过初次读取、文件追加、双载体去重及加权均值测试；数据位于独立测试 CODEX_HOME，未查询真实账号。
- 全部 TypeScript / Node 测试：31 项通过。
- `npm run build`：TypeScript 和 Vite 构建通过。
- 新增面板：5 种窗口尺寸、深浅主题共 10 张截图；会话固定、模型切换、历史状态、断线恢复、缺失数据、隐藏窗口停止轮询和英文界面通过。已人工查看桌面和 320px 窄屏截图。
- 原 Neumorphism 界面回归：6 种窗口尺寸、38 张截图通过，包含弹窗、键盘焦点、对比度及减少动画设置。
- 本机聚合诊断已成功读取 8 个会话的模型与有效用量样本。这只能验证本机日志兼容性，不代表不同模型的性能排名。

浏览器测试全部使用隔离账号和模拟网络响应，不查询真实账号，不发送预热或模型请求。截图与测试报告位于 `Temp/token-speed-qa/`，原有界面回归位于 `Temp/neumorphism-qa/`。

构建保留工程原有的 6 条未使用项 / 平台条件编译警告；未为此改动无关模块。没有安装覆盖正在运行的应用，没有修改版本号，没有提交或推送 Git，也没有改动原有未跟踪文章目录。

## 本地预览程序

生成位置：`Temp/token-speed-preview/codex-switcher.exe`，约 14.7 MiB。SHA-256 保存在同目录 `SHA256.txt`。

先从托盘退出正在运行的旧版 Codex Switcher，再打开预览程序，在账号管理页查看新面板。不要同时运行新旧两个实例。没有覆盖已安装目录，也没有生成或发布安装包；本地预览仍使用工程现有版本号 0.2.18。

验证范围：已验证前端浏览器交互、Windows 编译、真实后端接口和本机日志聚合读取；未启动第二个真实账号桌面实例，未做 macOS / Linux 实机测试。浏览器截图里的模型名及 42.0 tok/s 等数值是隔离测试数据，不是模型性能测试结果。
