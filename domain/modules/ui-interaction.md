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
- HelpDialog（帮助弹窗）：顶部 toolbar 中 `?` 按钮触发，展示快捷键 + 核心操作 + 节点三态说明；ESC / 点遮罩 / 点 × 三路关闭；ESC 不分级（与 fullscreen 同时打开会一起关），详见 D025
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

## 流式响应粘底滚动
- 节点态（inline）和大屏态（fullscreen）的消息列表在流式响应期间默认跟随到底部，让用户始终看见最新增量
- 用户主动向上滚出底部后停止跟随；之后手动滚回接近底部时恢复跟随，后续增量自动继续置底
- "接近底部"判定带阈值容差（约 1～2 行字距离），避免用户向上滑几像素就被误判为离底而停跟
- 流式结束后监听不撤、但不主动滚动；下一轮流式按当前跟随状态决定是否置底（用户上轮停跟过则下轮也不跟，符合"用户意图持续生效"的直觉）
- 切换视图（节点 ↔ 大屏）视为重新进入会话场景，跟随状态强制重置为"跟随"——大屏态由独立组件实例承载，关闭大屏后节点态组件仍存活，单靠新挂载语义无法把"跟随状态"在两侧之间同步重置
- 增量信号覆盖 content / reasoningContent / agentTrace 三类字段——纯思考阶段（reasoning 流式但主回复未开始）也应自动跟随，否则用户须手动下滑才能看到 thinking 内容

## 分支创建（一键直达大屏对话框）
- 入口：助手消息气泡 hover 80ms 后右下角显示 `↳ 从这里分支` 按钮（与 user 气泡的 `✎ 编辑` 镜像对称）；流式中的助手消息不显示工具栏
- 落点统一为新节点的大屏 Modal：API 返回时调 openFullscreen(newNodeId) 直接覆盖单例 fullscreenNodeId
  - 从大屏 Modal 内分支：Modal 不关闭，对话内容切换到新节点（视觉上是"对话主题切换"，不是关再开）
  - 从 inline 节点分支：弹出新节点的大屏 Modal
  - 设计意图：用户创建分支的真正诉求是"在大窗口里基于一句话开个新对话"；落到画布节点会引入"关 Modal → 找节点 → 展开 → 点输入框"4 步手动操作，打断对话情境
- 视口同步：API 返回时画布平移到新节点中心（公式与"分支跳转"一致），用户 ESC 关闭 Modal 后即可看到新节点位于视野中央
- 输入框聚焦：大屏 Modal 内 textarea 自动获焦可立即打字；NodeChatPanel 在 fullscreen 模式下用 rAF 延迟到 commit 后再 focus；effect 依赖项含 `node.id` 以覆盖 fullscreenNodeId 切换时组件实例复用、effect 默认不重跑导致焦点停留在前一节点的场景
- 操作反馈：API 同步等待期间分支按钮显示 Loader2 转圈 + disabled，防重入；失败时 toast 提示 + 解锁
- 未做项：新 Modal 内不展示"分支自《父》第 N 条"banner（BranchSourceLine 仅在 inline ExpandedNodeView 中渲染，Modal 路径未渲染），后续优化项

## 分支可见性（双向标注）
- 一个父节点的同一条助手消息可派生多个子分支；用户必须能在父/子两个视角都看清"谁从谁岔出来"
- 子节点视角：折叠卡和展开 header 各显示一处"分支自《父标题》..."标注；展开态附带"第 N 条 + 父消息内容摘要"，折叠态因空间约束摘要降级到悬停提示
- 父节点视角：被分支的助手消息常驻"⑂ N"徽章（不依赖 hover；与 hover 才出现的"从这里分支"按钮分居气泡左右下角）；点击徽章弹出子节点列表浮层，点击外部关闭
- 摘要文本剥离 markdown 噪音（标题/列表/引用/代码块/链接外壳）后截断；纯视觉用途，不进入任何持久化数据
- 数据来源：分支边的 parentNodeId + inheritedUntilSequence 即可反查父消息；不需要新增持久化字段

## 分支跳转（一键定位关联消息）
- 子节点的"分支自..."标注、父节点徽章浮层的子节点条目，点击后都触发统一的"跳转 + 定位"复合动作：(1) 目标节点若折叠则自动展开（store + 后端持久化）；(2) 设为活跃节点；(3) pan 画布让目标节点居中到视口；(4) 滚动目标节点的消息列表到对应消息开头
- 子节点视角跳父节点：定位到"被分支的那条消息"开头（让用户看到分支起源的上下文）
- 父节点视角跳子节点：定位到子节点的"第一条消息"开头；子节点尚无消息时跳过滚动只完成展开+pan（兜底）
- pan 公式与 minimap 的 centerOn 同源（vx = winW/2 - lx*zoom）以保持视觉一致；节点中心点用 `positionX+180, positionY+120` 近似
- 滚动锚点用 `data-message-id` DOM 属性；定位最近的 `overflow-y:auto/scroll` 祖先（即节点的消息列表容器），手动 `scrollTo` 只滚该容器一个——不能用 `Element.scrollIntoView`（详见 edge-cases E018）
- 展开是异步重渲染，必须两层 requestAnimationFrame 等待 layout 完成后再滚，单层不够
- 不处理 fullscreen Modal 场景：Modal 遮罩拦截画布点击，此场景下用户无法触发跳转

## 用户消息编辑（重新生成 AI 回复）
- user 气泡 hover 80ms 后左下角显示 `✎ 编辑` 按钮（与 AssistantBubble 右下角的"↳ 从这里分支"按钮镜像对称，保持气泡尾部干净）
- 进入编辑模式后气泡变 textarea，预填原内容并自动 focus 到末尾
- Enter 提交 / Shift+Enter 换行 / ESC 取消（与节点 footer 输入框约定一致）
- 提交不弹确认对话框：被分支引用的消息按钮已 disabled（参见 R021），剩余编辑都不会破坏其他节点状态——直接执行截断+重发
- 按钮 disabled 条件：(1) 节点流式中（"AI 回复中，无法编辑"）；(2) 该消息被任一分支引用（"此消息已被分支引用，编辑会破坏分支上下文"）；disabled 时仍显示但灰色，让用户知道有这个能力
- 内容未变更或为空时静默取消（不发起截断+重发，避免无意义的 LLM 调用）
- 仅 user 消息可编辑，assistant 消息无任何编辑入口

## Agent 轨迹区块（M4 起 / D028 视觉重做）
- 视觉：暖米半透明背景 `rgba(245,233,210,0.5)` + 0.5px accent-200 边 / 圆角 token.radius.md / 内边距 12×16 / 字号 token.text.xs / 文字 token.color.ink-600（具体色值/字号走 R013 token 单一事实源）
- 步骤图标：thought ● 焦糖小圆点 / action 用 lucide ToolIcon 按 toolName 派发（web_search→Search、fetch_page→Globe、其他→Hammer，accent-500 色）/ failure 用 lucide X（token.color.danger） / final ● moss 副色
- 行间距 5px；长 thought >60 字默认省略 + 点击"展开"看完整（按钮 accent-600 + underline）
- 折叠/展开行为：流式期间默认展开 + 实时新 step 流入；streaming → complete 边沿触发自动折叠（仅一次，不会因用户后续展开重复触发）；折叠态用 lucide ChevronRight，展开按钮用 lucide ChevronDown
- 折叠态：单行汇总 "AI 搜索 N 次 / 阅读 M 个网页"（左侧 ChevronRight 图标 + 右侧"展开"提示）
- 启动过渡：streaming 已开始但 trace/reasoning/content 全空的瞬间显示三连 blink 焦糖小点 + "AI 正在准备工具调用…"（token.text.xs / ink-400 italic）
- 中断按钮：右上角圆形 lucide X，0.5px danger 边描，hover 切 danger 实心反白；M5 已接通中断 API（行为约束见 R015）
- 与 reasoning 区块的关系：AgentTrace 在 reasoning 之上独立显示——agentTrace 是粗粒度工具调用过程，reasoning 是模型内部 chain-of-thought，语义不合并
- 防止节点拖拽吞按钮事件：所有 trace 内交互按钮（中断 / 折叠 / 展开 / "展开"链接）必须 onPointerDown stopPropagation，与现有节点 header 按钮治理同源
