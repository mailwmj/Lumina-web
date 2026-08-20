# Lumina 视觉规范与设计 Token

> 用途：提炼当前 Lumina 实现中已经落地的视觉语言、设计 token 与组件约束，供另一个系统复用或改造。本文描述的是现有实现的稳定规则，不把单个业务页面的临时样式当作全局规范。

## 1. 视觉方向

Lumina 是一个面向创作流程的桌面画布工作台。视觉应当保持：

1. **中性、克制。** 大面积使用锌灰、黑、白建立信息层级，不用渐变或高饱和底色装饰页面。
2. **紧凑、工具化。** 常规操作在 32 至 40 px 的控制高度内完成；节点内的高频控制进一步缩至 24 px。
3. **颜色有明确语义。** 黄绿色只表达确认、激活和选中；紫色只表达画布的连线与连接点；红、绿、琥珀仅用于错误、成功和警告。
4. **层级轻而明确。** 优先使用低对比度边框、细微表面差和轻阴影，不使用厚边框或明显卡片阴影。
5. **画布优先。** 控制工具以悬浮条和按需显示的操作覆盖层出现，避免永久占用创作区域。

## 2. Token 架构

当前实现的全局 token 定义在 `src/index.css`，Tailwind 通过 `tailwind.config.js` 将 RGB 通道映射为 `bg-*`、`surface-*`、`text-*`、`accent-*` 等语义类。

### 2.1 色彩与表面

| Token | 浅色 | 深色 | 语义 |
| --- | --- | --- | --- |
| `--bg` | `#F4F4F5` | `#0A0A0B` | 常规页面背景 |
| `--canvas-bg` | `#F4F4F5` | `#030303` | 无限画布背景 |
| `--surface` | `#FFFFFF` | `#18181B` | 基础面板、节点外层 |
| `--ui-surface-elevated` | `#FFFFFF` | `#202024` | 菜单、提示、悬浮内容 |
| `--ui-surface-field` | `#FAFAFA` | `#111113` | 输入框、筛选器、chip |
| `--border` | `#E4E4E7` | `#2D2D32` | 实色边界基础值 |
| `--text` | `#18181B` | `#FAFAFA` | 主文本 |
| `--text-muted` | `#71717A` | `#A1A1AA` | 次级文本、元数据 |
| `--accent` | `#9DE500` | `#9DE500` | 主操作、激活、选中 |
| `--accent-foreground` | `#09090B` | 按对比度计算 | 主色表面上的文字和图标 |
| `--edge` | `#7C3AED` | `#8B5CF6` | 画布连线和端口，不作为品牌主色 |

### 2.2 透明度、边框与阴影

| Token | 浅色 | 深色 | 使用规则 |
| --- | --- | --- | --- |
| `--ui-border-soft` | `rgb(9 9 11 / 10%)` | `rgb(255 255 255 / 10%)` | 普通分隔、面板和字段边框 |
| `--ui-border-strong` | `rgb(9 9 11 / 17%)` | `rgb(255 255 255 / 17%)` | 输入悬停、节点闲置态等强调边界 |
| `--ui-hover` | `rgb(9 9 11 / 6%)` | `rgb(255 255 255 / 6%)` | 普通悬停背景 |
| `--ui-shadow-panel` | `0 10px 28px rgb(9 9 11 / 14%)` | `0 10px 28px rgb(0 0 0 / 34%)` | 对话框、菜单和浮层 |
| `--ui-shadow-toolbar` | `0 8px 24px rgb(9 9 11 / 18%)` | `0 8px 24px rgb(0 0 0 / 42%)` | 悬浮工具栏 |
| `--ui-shadow-tooltip` | `0 6px 18px rgb(9 9 11 / 18%)` | `0 6px 18px rgb(0 0 0 / 42%)` | Tooltip 与轻量提示 |
| `--node-selected-shadow` | 主色 40% 描边 + 10% 外发光 | 主色 48% 描边 + 12% 外发光 | 节点选中态 |

### 2.3 可迁移的 CSS 契约

另一个系统可保留相同的语义分层，变量名称可按该系统约定调整：

```css
:root {
  --ui-bg: #f4f4f5;
  --ui-canvas-bg: #f4f4f5;
  --ui-surface: #ffffff;
  --ui-surface-elevated: #ffffff;
  --ui-surface-field: #fafafa;
  --ui-text: #18181b;
  --ui-text-muted: #71717a;
  --ui-accent: #9de500;
  --ui-accent-fg: #09090b;
  --ui-edge: #7c3aed;
  --ui-border-soft: rgb(9 9 11 / 10%);
  --ui-border-strong: rgb(9 9 11 / 17%);
  --ui-hover: rgb(9 9 11 / 6%);
  --radius-control: 8px;
  --radius-panel: 10px;
  --radius-node: 10px;
}

[data-theme='dark'] {
  --ui-bg: #0a0a0b;
  --ui-canvas-bg: #030303;
  --ui-surface: #18181b;
  --ui-surface-elevated: #202024;
  --ui-surface-field: #111113;
  --ui-text: #fafafa;
  --ui-text-muted: #a1a1aa;
  --ui-edge: #8b5cf6;
  --ui-border-soft: rgb(255 255 255 / 10%);
  --ui-border-strong: rgb(255 255 255 / 17%);
  --ui-hover: rgb(255 255 255 / 6%);
}
```

## 3. 字体、尺寸与圆角

### 3.1 字体

| 场景 | 字体栈 | 规则 |
| --- | --- | --- |
| UI 正文 | `Geist Variable`, `Noto Sans SC`, `Noto Sans CJK SC`, `PingFang SC`, `Microsoft YaHei`, `Arial`, `sans-serif` | 中英文界面共用的无衬线栈 |
| macOS UI | `Geist Variable`, `PingFang SC`, `Noto Sans SC`, `Helvetica Neue`, `Arial`, `sans-serif` | 与 macOS 窗口环境更协调 |
| 数据与参数 | `Geist Mono Variable`, `SFMono-Regular`, `Consolas`, `monospace` | 比例、尺寸、模型参数、快捷信息 |

当前项目未通过 `@font-face` 内置 Geist 字体文件。若另一个系统需要像素级接近，应提供相应字体；否则保留中文系统字体回退栈。

### 3.2 尺寸与密度

| 规格 | 值 | 使用场景 |
| --- | --- | --- |
| 顶部标题栏 | `40px` | 固定窗口 chrome |
| 常规小按钮 | `32px` 高 | 工具栏、图标按钮、选择器 |
| 常规按钮 | `40px` 高 | 表单和对话框主要动作 |
| 节点底部控制条 | `32px` 高 | 生成节点统一底部行 |
| 节点控制 chip / 主按钮 | `24px` 高，`11px` 字号 | 模型、比例、生成等高频控制 |
| 菜单项 | `44px` 高 | 画布节点菜单 |
| 常用间距 | `2/4/6/8/10/12/14/16/24px` | 以 4px 为基础，但允许紧凑的 2px 级微间距 |

### 3.3 圆角

| Token / 形态 | 值 | 使用场景 |
| --- | --- | --- |
| `--ui-radius-control` | `8px` | 输入框、常规按钮、chip |
| `--ui-radius-panel` | `10px` | 面板、菜单、弹窗 |
| `--node-radius` | `10px` | 画布节点 |
| 选择器触发器 | `6px` | 紧凑 select |
| 选择器选项 | `4px` | 下拉菜单内部项 |
| 悬浮工具条、图标操作 | `9999px` | 圆形图标按钮和底部工具条 |

整体形状应偏锐利、技术化；不要把常规控件扩大为 12px 以上圆角，也不要把所有容器做成胶囊形。

## 4. 组件与状态规范

### 4.1 通用组件

| 组件 | 默认样式 | 激活 / 悬停 / 禁用 |
| --- | --- | --- |
| 主按钮 | 黄绿色背景、深色前景、40px 高 | 悬停降低主色不透明度；禁用 50% 不透明度 |
| 次按钮 | field 背景、soft border、主文本 | 悬停 `--ui-hover` |
| 幽灵按钮 | 透明背景、主文本 | 悬停 `--ui-hover` |
| 危险按钮 | 红色背景或红色文字 | 仅用于不可逆操作 |
| 输入框 / 文本域 | field 背景、soft border、8px 圆角 | focus 使用主色边框 |
| 图标按钮 | 通常 32 或 40px 方形 | 激活为主色 15 至 18% 背景、主色图标 |
| 下拉菜单 | elevated surface、soft border、panel shadow | 当前项使用完整主色背景；禁用 40% 不透明度 |
| Tooltip | elevated surface、11px 字号、6px 圆角 | 420ms 延迟显示 |
| 对话框 | panel surface、10px 圆角、panel shadow | 黑色遮罩约 55 至 65% |

### 4.2 交互状态

1. 按钮和可点击元素键盘聚焦时使用 `2px` 主色描边，偏移 `2px`。
2. 输入类控件聚焦时不使用浏览器默认外框，改为主色边框。
3. 通用悬停只改变背景或边框，不在正常操作上同时增加阴影和高饱和颜色。
4. 选中节点使用主色边框与轻量外发光；闲置节点使用 strong border，悬停时才向主色过渡。
5. 禁用态一般使用 `40%`、`50%` 或 `55%` 不透明度，不改变布局尺寸。

## 5. 动效规范

| 场景 | 时长 | 表现 |
| --- | --- | --- |
| 节点端口显隐 | `120ms` | 仅 opacity；悬停或连线中显示 |
| Popover | `140ms` | opacity + 轻微上移 / 下移 |
| 面板进入 | `160ms` opacity，`180ms` transform | `translateY(8px) scale(0.98)` 到静止位置 |
| 面板退出 | `130ms` opacity，`150ms` transform | 回到 `translateY(8px) scale(0.98)` |
| 对话框 | `180ms` | opacity 过渡 |
| 画布流动连线 | `0.6s` 选中，`0.9s` 处理中 | 线性虚线流动；支持 reduced motion 时关闭 |

不使用弹簧、回弹或长时间装饰性动画。动效只用于确认层级、状态变化与画布任务进行中。

## 6. 画布专用规则

1. 深色画布为 `#030303`；网格保持中性，不借用主色。
2. 网格由点阵和正负 45 度细线组成，缩放基准间隔为 `72px`；点径 `1.05px`，斜线半宽 `0.45px`，整体不透明度 `0.92`。
3. 连接端口为 `20 x 20px`，白色 `3px` 边框，内部填充关系色；普通端口只在节点悬停或连线过程中显示。
4. 常规连线使用关系色低透明度虚线；选中或处理中增强线宽、亮度和虚线流动效果。
5. 底部画布工具条为 `44px` 高的圆角胶囊，使用 panel surface、soft border 和 toolbar shadow；其图标按钮为 `32px` 圆形。
6. 节点操作条置于节点上方、水平居中，与节点间距 `16px`；仅显示与当前选中节点相关的动作。

## 7. 图标与文案

1. 使用 Hugeicons 的线性图标；默认图标为 `16px`、`1.8px` 描边，随文字颜色继承。
2. 节点紧凑控制区使用 `12px` 图标；标题栏和画布工具条使用 `16px` 图标。
3. 图标用于解释操作而不是装饰。只有图标的按钮必须有 tooltip 和可访问名称。
4. 文案保持短、动词优先。标题常用 `14px` medium，辅助信息常用 `12px`，节点内部的高密度元信息可降至 `9 至 11px`。

## 8. 语义色与迁移边界

当前错误、成功、警告在部分组件中直接使用 Tailwind 的 `red-*`、`emerald-*`、`amber-*`，尚未完全收敛为 CSS 变量。迁移时应补齐以下 token，而不要将它们与 `--accent` 或 `--edge` 混用：

```css
:root {
  --color-danger: #ef4444;
  --color-success: #10b981;
  --color-warning: #f59e0b;
}
```

迁移后应遵守：

1. 不把紫色关系色扩展为普通按钮、导航或品牌色。
2. 不让黄绿色覆盖大面积表面；它只承担动作、选中和状态确认。
3. 不把局部节点特效、图片加载遮罩或业务错误样式提升为通用组件默认样式。
4. 为任意可配置主色同步计算深色或浅色前景，以保证按钮文字对比度；Lumina 当前在运行时根据对比度自动选择 `#09090B` 或 `#FAFAFA`。

## 9. 源码依据

| 主题 | 来源 |
| --- | --- |
| 全局颜色、表面、阴影、圆角、画布网格和动效 | `src/index.css` |
| Tailwind 语义颜色映射和字体映射 | `tailwind.config.js` |
| 主色默认值、校验、迁移和前景对比度 | `src/features/settings/application/accentColor.ts` |
| 运行时主色注入 | `src/App.tsx` |
| 按钮、输入、选择器、弹窗等基础原语 | `src/components/ui/primitives.tsx` |
| Tooltip、图标和浮层时间 | `src/components/ui/Tooltip.tsx`、`src/components/ui/Icon.tsx`、`src/components/ui/motion.ts` |
| 节点表面、底部控制条和工具条位置 | `src/features/canvas/ui/nodeSurfaceStyles.ts`、`src/features/canvas/ui/nodeControlStyles.ts`、`src/features/canvas/ui/nodeToolbarConfig.ts` |
| 画布工具条、节点菜单和连线状态 | `src/features/canvas/CanvasToolbar.tsx`、`src/features/canvas/NodeSelectionMenu.tsx`、`src/features/canvas/edges/DisconnectableEdge.tsx` |

