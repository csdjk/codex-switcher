# Codex Switcher — Mist / Neumorphism

本设计规范适用于 React + Tailwind v4 + Tauri 桌面端、托盘和浏览器管理面板。2026-09-20 根据用户指定的 Neumorphism 风格实施；不是发布版本，也不改变账号、签名更新或原生任务栏图标逻辑。

## 依据与取舍

已读取本机 `ui-ux-pro-max/SKILL.md`、`references/pro-rules.md` 与 `references/quick-reference.md`，实际执行 `scripts/search.py`：

- `desktop productivity neumorphism --design-system`：返回 Flat Design 与营销页面结构，不符合指定风格，未采用。
- `neumorphism soft UI --design-system`：返回 Soft UI Evolution；仅参考可读性与柔和层次，未采用粉紫营销配色和页面结构。
- `neumorphism --domain style -n 1`：精确命中 Neumorphism，包括 12–16px 圆角、单色粉彩、多层阴影、150ms 按压、内凹／外凸以及对比度与键盘风险提示，作为风格依据。
- `accessible focus keyboard --stack react`：采用弹窗焦点限制、关闭后返回触发位置与可访问名称测试。

## 视觉约定

雾蓝灰材质贯穿背景与卡片，不以白色硬边框分割。光源固定左上：亮阴影在左上、暗阴影在右下，不能在不同组件中反转。布局采用 4/8px 节奏，桌面页宽 1144px，主要卡片圆角 16px，按钮与输入框 12–14px。

| 角色 | 浅色 | 深色 |
| --- | --- | --- |
| 主背景／材质 | `#e8edf2` | `#252e3b` |
| 正文 | `#293d52` | `#e3ebf4` |
| 次级文字 | `#576a7e` | `#b1c0d1` |
| 单色强调 | `#4c7093` | `#adc7e2` |
| 焦点 | `#365f89` | `#bddcff` |

系统字体栈使用 Segoe UI Variable Text、Segoe UI、Microsoft YaHei UI 和 system-ui，不下载或复制字体。数据使用等宽数字。结构性图标使用本地 SVG `UiIcon`，不用 emoji 或外部图标字体。

## 层次与交互

- 外凸：账号卡片、统计块、概览指标、普通按钮。
- 内凹：输入框、额度槽、图表、当前账号状态与开关选中状态。
- 主操作：单色深蓝按钮，避免每项功能都使用不同彩色底板。
- 语义提示：低额度保留少量赭黄／暗红，危险操作保留红色与文字，不依靠颜色独立表达含义。原生任务栏圆环颜色阈值不改。
- 悬浮／按压：150ms 阴影与颜色反馈，不移动布局边界。无持续装饰动画；尊重 `prefers-reduced-motion`。
- 焦点：键盘使用独立可见轮廓；“无硬线”不覆盖无障碍焦点与强制对比模式。
- 弹窗：16px 圆角、遮罩隔离、Escape 关闭、Tab 限制在弹窗内；异步危险操作期间不得借 Escape 绕过禁用规则。
- 响应式：主面板在窄屏改为纵向排列，保留可滚动内容，不能通过隐藏溢出掩盖布局错误。托盘独立采用紧凑密度，尺寸不扩大到主窗口规格。

## 实现入口

`src/styles/neumorphism.css` 集中保存主题 token、材质、阴影、交互与断点；通过 `src/App.css` 引入。业务组件使用 `neu-*` 语义类；已有 Tailwind 布局工具类保留，避免为了换肤重写状态与接口。

`AccountOverview` 只使用现有已加载账号与额度计算概要，不发出额外请求。`useDialogFocus` 负责弹窗焦点，不接触业务数据。

## 验证范围

以隔离测试账号检查主界面、设置、添加／导入账号、会话管理、托盘、更新提示；在深浅主题与桌面／窄屏／横屏尺寸检查实际截图、横向溢出、键盘焦点、减少动画及正文 token 对比度。运行原有回归与原生 Windows 构建。

截图只使用测试数据，不公开本机真实账号、凭据、会话或路径。构建和局部对比度测试不等同于完整无障碍认证或 macOS／Linux 实机验收。
