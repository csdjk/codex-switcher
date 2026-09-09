# Windows 动态额度图标验收

日期：2026-09-09。用户确认同时用于任务栏应用图标和右下角通知区域图标。

## 行为

- 两处图标复用同一个原生 RGBA 绘制函数，显示剩余额度数字与条形进度。
- 只选择当前账号的额度。多个额度窗口同时存在时，显示剩余最少的一项；只有一项时显示该项。
- 大于 30% 为绿色，11%–30% 为黄色，0%–10% 为红色。未知、缺失或查询失败显示灰色 `--`，不会显示为 0%。
- 悬停托盘图标可查看各额度窗口的剩余百分比，以及“取剩余最少的一项”的说明。
- 页面回传额度或原生后台每 60 秒轮询时更新。原生后台轮询在主窗口隐藏后仍运行；账号库变更后重新选取当前账号数据。
- 仅 Windows 改变图标；原有 macOS/Linux 图标逻辑保留。任务栏图标属于正在运行的原生窗口，浏览器预览和未运行时的快捷方式图标不属于动态显示范围。

## 实现

- `src-tauri/src/quota_icon.rs`：额度选择、颜色和 32×32 像素绘制，无新依赖和图片文件。
- `src-tauri/src/tray.rs`：更新主窗口与托盘图标、悬停说明，Windows 后台查询失败时清除旧额度。
- `src-tauri/examples/quota_icon_preview.rs`：独立原生视觉检查程序，依次展示 80%、26%、8%、0%、未知；不读取账号库、不查询网络、不切换真实账号，40 秒后退出。
- `src-tauri/build.rs`：为 Windows 示例程序补齐 Common Controls 6 清单，避免原生示例加载 `TaskDialogIndirect` 时出现入口点缺失。

## 验证

- `cargo test --locked --lib quota_icon`：3 项通过，覆盖最小剩余额度、缺失和错误、越界、NaN，以及 0–100 和未知的绘制。
- `cargo build --locked --features tauri/custom-protocol --bin codex-switcher`：通过。
- `cargo build --locked --features tauri/custom-protocol --example quota_icon_preview`：通过。
- 真实桌面程序已运行，任务栏和托盘都实际显示当前账号的 26%；随后随真实额度变化更新为 25%。没有通过切换账号或修改额度来构造该结果。
- 原生截图环境：Windows，桌面 2560×1440，任务栏区域 `(0,1392,2560,48)`，100% 缩放。通过只读 Win32/系统截图接口取图，没有移动鼠标。测试托盘图标被 Windows 收入隐藏区域时，通过 UI Automation 调用“显示隐藏的图标”，截图后收起。
- 真实任务栏截图：`Temp/quota-icon-qa/live-taskbar.png`。
- 独立窗口的边界状态截图：`Temp/quota-icon-qa/qa-{80,26,8,0,unknown}-taskbar.png`；裁剪图为相同名称的 `-crop.png`；通知区域截图为 `-tray.png`。
- 已人工核对数字可读性、数字与进度条是否一致、三档颜色、零额度和未知状态的区别。没有视觉设计参考图，因此不适用设计稿相似度指标。

未验证 Windows 不同缩放、多显示器任务栏、Explorer 重启、安装包和固定快捷方式的图标行为；本次没有执行真实账号切换。测试程序会自行退出，原生应用保留运行。
