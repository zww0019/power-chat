# UI 交互层（前端画布行为）

## 职责
画布的指针/键盘/选择/拖拽行为约定，跨节点 / 边 / 设置弹窗的统一行为基线。

## 选择模型
- 三种状态：active(node) / selected(nodes[]) / selected(edge)
- 互斥：进入任一态时清空另两态（避免 Delete 键歧义）
- "active" 是单选 + 焦点（输入框聚焦）；"selected nodes" 是多选（提炼用）；"selected edge" 是单选

## 拖拽与 setPointerCapture
- 节点拖拽 / 画布平移都用 setPointerCapture，保证鼠标拖出容器边界时事件不丢
- capture 生效后 click 事件不可靠 → 单击行为统一在 pointerup 时按位移阈值（< 4px）判定
- 任何"在拖拽容器内"的按钮（折叠按钮、× 删除按钮、分支按钮）必须 onPointerDown stopPropagation，阻止 capture 链建立

## 删除快捷键
- Delete / Backspace
- 焦点保护：在 INPUT / TEXTAREA / contentEditable 中失效
- 优先级：selected edge > active node（互斥状态决定，理论上同时只有一个）

## 弹窗模态
- SettingsDialog：未配置时强制弹出，背景遮罩点击关闭
- NodeFullscreenModal（节点大屏对话框）：节点 header 点 `⛶` 触发，三种关闭路径——ESC / 点遮罩 / 点 ×；详见 glossary "大屏对话框" 与 D022
- 弹窗内的输入控件不应吞掉删除键（已被焦点保护覆盖）

## 全局预览（Minimap）
- 右下角 fixed 缩略视窗，与画布 transform 解耦（不参与 pan/zoom）
- 单击空白处 → centerOn 跳转视口；视口框内按下 → 拖拽同步视口
- 写入路径只走 `setViewport` 写 store，App 顶层 `useEffect([canvas])` 依赖 zustand 对象引用变化反向同步本地 vx/vy/zoom state
- 不显示 edge / 不提供 toggle / 不持久化显隐（详见 D023）

## SVG 边层渲染约束
- SVG 容器 pointerEvents: 'none'（防吞背景双击）
- 边的命中区单独 pointerEvents="stroke"，14px 宽透明粗线
- 视觉线 pointerEvents: 'none'，只承担显示
- 选中态视觉变化 + 中点显示 × 删除按钮

## AI 思考过程的展开/折叠
- 流式期间默认展开（用户可主动折叠）
- 自动折叠**仅在流式 → 完成的那一次**触发：状态转换瞬间若仍展开，延迟一段时间后自动收起；之后无论用户折叠/展开多少次，均不再被自动折叠吞掉
- 边沿触发而非"凡是 complete 就触发"：避免用户手动展开后立即被定时器再次折叠的体验缺陷
- 已存档消息（进入组件时已是 complete 态）永不被自动折叠

## 节点内滚动与画布滚动的边界穿透
- 展开态节点的内容区可独立纵向滚动；画布也用 wheel 事件做平移
- 行为约定：内容未到顶/底时拦截事件冒泡，由节点内部独占滚动；滚到顶/底边界后继续同向滚动则放行给画布平移
- 边界判断带 1px 容差（应对亚像素 / DPR 缩放下的浮点误差）
- 不拦截横向 wheel（保持与画布水平平移一致）

## Agent 轨迹区块（M4 起）
- 视觉：浅冷灰 `#F5F4EE` 背景 / 圆角 6 / 内边距 10/12 / 字号 11px（R013 token） / text-secondary
- 步骤图标：thought ●（4px 圆点）/ action → / failure ✕（颜色 `#A32D2D` 暗红）/ final ●
- 行间距 6px；长 thought >60 字默认省略 + 点击展开看完整
- 折叠/展开行为：流式期间默认展开 + 实时新 step 流入；streaming → complete 边沿触发自动折叠（仅一次，不会因用户后续展开重复触发）
- 折叠态：单行汇总 "▸ AI 搜索 N 次 / 阅读 M 个网页（展开 ↓）"
- 启动过渡：streaming 已开始但 trace/reasoning/content 全空的瞬间显示 "AI 正在准备工具调用…"（11px text-tertiary）
- 中断按钮：右上角浅色 ⨯，M4 阶段 disabled（临时豁免 R015，详见 modules/agent.md "M4 临时豁免"），M5 接通中断 API 后启用
- 与 reasoning 区块的关系：AgentTrace 在 reasoning 之上独立显示——agentTrace 是粗粒度工具调用过程，reasoning 是模型内部 chain-of-thought，语义不合并
- 防止节点拖拽吞按钮事件：所有 trace 内交互按钮（中断 / 折叠 / 展开 / "展开"链接）必须 onPointerDown stopPropagation，与现有节点 header 按钮治理同源
