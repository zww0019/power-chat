# 业务硬规则

## R001 · 删除节点级联删除其入/出边和所有 messages
- 子孙节点保留（断链而非递归删除）
- 来源：INV-5 / Q2-3 选 B（旧文档 docs/02-domain-model.md）
- 最后确认：2026-04-26

## R002 · 流式输出中的节点不可删除
- 强制返回 409 `streaming` 错误
- 前端必须给用户明确提示，而非静默失败
- 来源：INV-7
- 最后确认：2026-04-26

## R003 · 边的删除无副作用
- 不影响两端节点
- 不影响节点上的 messages
- 来源：本轮新增功能（2B 删除）
- 最后确认：2026-04-26

## R004 · 三种选择状态互斥
- 活跃节点 / 选中节点集合 / 选中边 同一时刻只能存在一种
- 切换任一选择动作时必须同步清空其他两种
- 来源：避免删除快捷键产生"删节点还是删边"的歧义
- 最后确认：2026-04-26

## R005 · 删除快捷键焦点保护
- `Delete` / `Backspace` 仅在画布层面生效
- 焦点位于 `INPUT` / `TEXTAREA` / `contentEditable` 控件中时**不响应**
- 来源：避免吞掉用户文本编辑
- 最后确认：2026-04-26

## R006 · 节点删除范围仅限活跃节点
- 即使存在多选集合，删除快捷键也只删活跃节点
- 多选集合的语义专属于"提炼"动作
- 来源：本轮决策 D001
- 最后确认：2026-04-26

## R007 · 边创建权限受限
- 边只能由 conversation/refine 模块在内部隐式创建（分支动作 / 提炼任务）
- 不暴露 HTTP/IPC 创建端点，用户不能手动拉线
- 来源：docs/02-domain-model.md（历史规则）
- 最后确认：2026-04-26

## R008 · LLM 调用未配置守卫
- `baseURL` / `model` / `apiKey` 任一为空即视为"未配置"
- 未配置时禁止发起 LLM 调用，前端检测到此态必须强制引导用户配置
- 来源：INV-9
- 最后确认：2026-04-26

## R009 · apiKey 持久化与传输隔离
- 真实 apiKey 仅以明文写入本地数据文件，不进入网络传输
- 服务端对外（HTTP/IPC）返回的 apiKey 永远是脱敏值
- 前端表单不得将脱敏值作为提交数据写回
- **覆盖范围**：所有 apiKey 类敏感字段（M3 起含 `llmApiKey` + `tavilyApiKey`；未来新增 key 字段必须延续此治理）
- 来源：本轮决策 D004（apiKey 脱敏防覆写约束）
- 最后确认：2026-04-26

## R010 · AI 调用对画布概念零感知
- 任何 LLM system / user prompt 中**禁止出现** "画布"/"节点"/"分支"/"提炼" 等产品概念
- 三种调用对 AI 而言分别是：一次普通对话 / 一份写作任务（基于材料写纲要）/ 一次概括任务
- 来源：视觉规范文档 §四 · "首版 Prompt 模板"前置原则
- 最后确认：2026-04-26

## R011 · 提炼输出强制四栏结构
- 提炼任务输出必须包含 `【核心结论】` `【关键论据】` `【未解决 / 待验证】` `【可能的下一步】` 四栏
- "未解决 / 待验证" 栏**不可省略**（产品对用户的诚实承诺：不假装清晰）
- 总长度不超过 400 字
- 来源：视觉规范文档 §4.2
- 最后确认：2026-04-26

## R012 · 节点标题为 8–15 汉字名词性短语
- 双轨制（D006）：
  - **自动轨**：每 3 轮对话（messages.length 满足 ≥6 且 % 6 === 0）后端 `sendMessage.onComplete` 触发，通过 SSE `title` / `title_error` 事件透传
  - **主动轨**：用户点击节点 header / 折叠卡 / 大屏 Modal 标题旁的 ↻ 图标按钮，调 `POST /api/nodes/:id/regenerate-title`
- 永远强制重新生成（两轨都不判断 node.title 是否已有值）；失败 toast 提示原因，旧标题保留不变
- 必须是名词性短语，不允许动词起头（"东南亚消费习惯差异" √；"讨论了东南亚消费习惯差异" ×）
- max_tokens 硬上限 30 / temperature 0.2 / 用 `settings.llmFastModel ?? settings.llmModel`
- 来源：视觉规范文档 §4.3 + 决策 D006（2026-04-27 双轨制版）
- 最后确认：2026-04-27

## R013 · 视觉硬约束

**单一事实源**：`prototype/src/styles/tokens.css`（CSS 变量）+ `prototype/src/styles/theme.ts`（TS 镜像）。组件内禁止硬编码色值/字号/圆角/阴影/动效，一律走 token。token 命名见 D028。
**共享 primitives**：弹窗外壳 / 图标按钮 / 关闭按钮 / 主次按钮由 `prototype/src/canvas/_dialogPrimitives.tsx` 提供（ModalShell / IconButton / CloseButton / DialogButton）。新增弹窗复用 ModalShell；新增 icon 按钮复用 IconButton；新增主/次按钮复用 DialogButton。

### 节点几何（不可变量）
- 折叠态宽 200px / 展开态宽 360px（任何场景不得突破）
- 折叠态高度（连线锚点必须按真实高度计算，否则曲线穿越卡片正面遮盖文字）：对话节点无来源行 68px、对话节点带"分支自《》"来源行 88px、提炼节点 72px
- 展开态 header 高 44px / 大屏 Modal header 高 60px
- 边框：默认 ink-200 0.5px / refined accent-300 1px / active accent-500 1.5px / selected moss-500 1.5px；阴影默认 shadow.md / active shadow.lg
- 提炼节点顶部 3px 焦糖渐变饰条（accent-400 → accent-500）
- 节点尺寸单一事实源：`prototype/src/canvas/node-dimensions.ts`，渲染层（Node.tsx）与连线几何层（edge-geometry.ts）必须共用此处常量

### 大屏 Modal（节点 fullscreen）
- 容器 `min(72vw, 920px) × min(82vh, 820px)`；遮罩 `rgba(42,40,32,0.45)` + backdrop-blur 6px；圆角 radius.xl
- header 高 60px、标题字号 text.lg（18）；body padding `${space.s5}px ${space.s7}px`
- 关闭路径：ESC / 点遮罩 / 关闭按钮 三路

### 画布与连线（PRD §3.2 克制视觉）
- 画布主底 color.paper、外底 color.canvas；圆点网格 1px、间距 24px、`rgba(60,48,28,0.06)`
- 连线默认 1.25px ink-300 / 选中 1.75px accent-500，过渡 200ms easeOutSoft；**无箭头、无文本标签**
- 边几何：cubic bezier 自适应 4 方向锚点（按父子节点中心点 dx/dy 主轴方向择最近一对边中点为起终点，控制点沿锚点法向外推 |delta|/2；锚点坐标按节点 collapsed/expanded 真实尺寸计算）
- 删除按钮：圆形 + accent-500 描边 + halo；× 用两条 SVG line 绘制（lucide stroke 风格）

### Minimap
- 右下角 fixed，200×132，背景 `rgba(251,249,242,0.82)` + backdrop-blur 20px、圆角 radius.lg、阴影 shadow.md
- 节点矩形按 bbox 等比缩放：折叠对话节点按最大可能高度 88 兜底（≥实际 68/88 任一）、折叠提炼节点 72、展开节点估算 360×360；尺寸常量统一从 `node-dimensions.ts` 引入。视口框 accent-500 描边 1.25px + 填充 alpha 0.08

### 顶部工具栏（三段式 floating bar）
- 左 Logo 胶囊 / 中提炼按钮（多选时出现，焦糖渐变 + shadow.accent）/ 右状态条 + 帮助 + 设置
- 各段半透明 paper（rgba 0.72）+ backdrop-blur 20px + radius.pill；段内按钮 34×34 圆角 radius.md，hover ink-100 底 + accent-600 色

### 消息悬浮工具栏（D027 形态保留 + D028 视觉重做）
- user 工具栏右下 / assistant 工具栏左下；位置 `bottom: -10px`
- 容器：raised 底 + 0.5px ink-200 边 + shadow.sm + radius.pill；按钮 hover/highlighted 切 accent-50 底 + accent-600 色
- 按钮项：user=`<Pencil>`；assistant=`<Copy> + <GitBranch> + [<GitBranch> + N]`（已派生分支时追加，点击展开浮层；浮层 open 时工具栏强制保持可见 + 按钮 highlighted）
- 触发：hover 80ms 防抖；由 NodeChatPanel 内 `MessageToolbar` + `ToolbarIconButton` 组件提供

### 编辑模式按钮（UserBubbleEditor）
- 取消/提交保留胶囊形：fontSize text.xs / padding 5×14 / radius.pill / fontWeight 500，由 `pillBase` 常量提供
- 提交按钮焦糖渐变 + shadow.accent；取消按钮 raised 底 + ink-200 边

### Modal / 浮层 zIndex 层级表（高在前层）
SettingsDialog 1000 / RefinePopover 1000 / ToastContainer 1000 / HelpDialog 300 / NodeFullscreenModal 200 / toolbar 100 / minimap 90；新增 Modal 应落入此区间。

### 字号阶梯（token.text.*，禁用 token 外档位）
xs 12 / sm 13 / base 15 / md 16 / lg 18 / xl 22；fontWeight 启用 400/500/600/700 四档（D028 撤销了 D026 的"禁用 600+"约束以增加层次）。

### 图标系统
- 全部使用 `lucide-react`；Unicode/Emoji 仅允许在 SVG 内绘制特殊场景使用（如 Edge 删除按钮的两条交叉 line 模拟 X，而不是嵌套外层 SVG 的 lucide 组件）
- size 13–18 / strokeWidth 1.6–2.0

### 动效
- ease：easeOutExpo / easeOutSoft / easeInOut；时长 durFast 140ms / durBase 200ms / durSlow 280ms
- keyframes：spin / blink / toast-in / modal-in / overlay-in（定义在 tokens.css 末尾）
- 标准复合：弹窗 overlay-in + modal-in 双层；Toast toast-in 入场；节点 hover/active 200ms 过渡；连线选中色变 200ms；流式光标 blink 1.06s step-end

- 来源：视觉规范文档 §一/二/三 + 2026-04-26 fullscreen/minimap 增量 + 2026-04-26 自适应锚点修复（D024）+ 2026-04-26 帮助弹窗（D025）+ 2026-04-27 字号松绑（D026）+ 2026-04-27 工具栏改造（D027）+ 2026-04-27 暖质感视觉系统重做（D028）
- 最后确认: 2026-04-27

## R014 · Agent 启动权属用户（原则 C）
- agent 的合法触发是用户用动作动词（"搜""查""找""读""帮我搜"等）明确表达的工具使用意图
- 模糊的话题展开（"我想了解 X""这个怎么样"）**不构成**启动授权——AI 应改用对话方式澄清，**禁止**擅自跑工具
- 实施层：约束写入 system prompt 引导 LLM 保守判断；前端**不做**关键词预检（保持对话语义不被前端侵入）
- 来源：agent-design.md §二 / §4.1
- 最后确认：2026-04-26

## R015 · Agent 过程透明且可中断（原则 D）
- ReAct 的每一步 thought / action / observation 必须实时通过 SSE 推给前端，不允许"事后折叠仅给结论"
- 中断按钮在 agent 跑动期间始终可点；用户在任何 step 都能立即终止当前 loop
- 中断不是降级措施，是核心交互——视觉与可达性等同主交互按钮
- 来源：agent-design.md §二 · 原则 D / §4.4
- 最后确认：2026-04-26

## R016 · Agent 产出物仅为对话回复（原则 E）
- agent 跑完后，输出仍只是一条普通的 AI 对话消息，进入当前节点的对话流
- agent **不**自动建新节点、**不**自动分支、**不**自动提炼
- 这些结构化操作仍只能由用户手动触发——遵守画布产品的"用户主权"根原则
- 来源：agent-design.md §二 · 原则 E
- 最后确认：2026-04-26

## R017 · Agent 不感知画布（R010 在 agent 场景的延伸）
- agent 的工具集是固定且封闭的：仅 web_search / fetch_page
- 工具集**不包含**任何能访问画布的能力——不能读其他节点、看连线、感知用户在画布上的其他动作
- agent system prompt **禁止**出现"画布""节点""分支""提炼"等产品概念（沿用 R010 边界）
- 来源：agent-design.md §3.2
- 最后确认：2026-04-26

## R018 · Agent 硬约束触限即停
- 单次 agent loop 最多 8 步、最长 3 分钟、同种工具最多调用 5 次
- 单次网页读取内容上限 50_000 字符（超出截断并标记 truncated=true）
- 全局并发 1（用户在节点 B 触发时若节点 A 仍在跑，提示"等待节点 A 完成"）
- 触限后强制结束 loop，把已收集信息交给 AI 做最终回复，向前端推 `agent_final` 事件并附上对应 reason
- 软建议（"5 步停下来汇报"等）写在 prompt 里，硬约束写在产品代码里——两层不互替
- 来源：agent-design.md §六
- 最后确认：2026-04-26

## R019 · INV-11 扩展：agentTrace 不回灌下游 LLM
- `Message.agentTrace`（thought/action/observation）仅供用户查看与产品 UI 渲染，**协议无关**
- 节点对话上下文组装（assembleContext / toLLMMessage）时**必须剥离** agentTrace
- 同节点连续 agent 调用、提炼任务、跨节点继承——所有下游 LLM 输入都不包含历史 agentTrace
- 用户若希望某段轨迹内容被纳入下游对话，必须在主线对话里**显式引用**那段材料
- **不与 reasoningContent 同等待遇**（2026-04-26 修正）：reasoningContent 按协议要求传递（详见 R020），与 agentTrace 的"协议无关永不回传"语义不同；R019 仅约束 agentTrace
- 来源：agent-design.md §3.3 / §3.4 / INV-11 扩展
- 最后确认：2026-04-26（语义拆分修正）

## R020a · reasoningContent 跨段路径按协议要求透传
- 跨段语境（assembleContext 输出，每个 user 是新段开头）：
  - **DeepSeek-Reasoner**：跨段历史 reasoning_content **可省略**（传了 API 也忽略，无害）
  - **Anthropic Extended Thinking**：字段名 thinking
  - **OpenAI o1 系列**：服务端管理状态不需回传
- 实施约束（conversation 跨段路径）：
  - `Message.reasoningContent` 持久化层始终保留（数据完整 + 前端展示需要）
  - `toLLMMessage`（conversation 模块）按白名单透传到 `LLMMessage.reasoningContent`
  - `toOpenAIMessage`（llm-client 模块）始终写入 `reasoning_content`（不支持的模型忽略此字段；不按模型族分支判断）
  - `estimateMessagesTokens` 必须包含 reasoningContent 估算（避免 ContextOverflowError 80% 阈值漏判）
- **不同于 R019**：R019 是协议无关"agentTrace 永不回传"；R020a 是"协议要求允许传递"——两者动机不同
- 来源：DeepSeek 思考模式协议 / 用户 2026-04-26 报告
- 最后确认：2026-04-26

## R021 · 被分支引用的消息不可截断/编辑
- 截断式删除消息（`truncateMessages(nodeId, fromSequence)`）必须先检查所有出边 branch 边
- 任一出边 `inheritedUntilSequence ≥ fromSequence` → 拒绝操作，抛 `MessageReferencedByBranchError`，HTTP 映射 409 `branch_referenced`（response 带受影响子节点 id 列表）
- 用户编辑用户消息时前端按钮先做 disabled 兜底（同语义判定），后端守卫防竞态
- 不能"自动级联删除子分支"：删用户数据风险大；不能"silently 截短继承上下文"：违反 INV-3 的引用语义
- 来源：用户 2026-04-27 提出消息编辑+重生成需求时的硬决策（方向 2c）
- 最后确认：2026-04-27

## R020b · reasoningContent 段内 sub-turn 必须回传（agent loop 内部）
- 段内语境（agent loop 内部多 sub-turn 之间，同一 user 之后到下一个 user 之前）：
  - **DeepSeek-Reasoner native_tools 模式 + enableReasoning=true + 有 tool_calls**：assistant 历史的 reasoning_content **必须**回传给所有后续段内调用，**不带 → 400 invalid_request_error**
  - 这是 DeepSeek 思考模式的协议硬约束（详见 deepseek 文档"工具调用"小节）
- 实施约束（agent.runAgentLoop 段内路径）：
  - `runOneLLMRound` 必须累积 reasoning delta 到 `OneRoundResult.reasoningBuf`
  - `runAgentLoop` push assistant tool_calls message 时必须携带 `reasoningContent: round.reasoningBuf`
  - 与 content + tool_calls + reasoning_content 三字段同时存在的 OpenAI 兼容协议形态对齐
- **react_text 模式不受约束**：deepseek-reasoner 等推理模型黑名单命中走 react_text 文本协议，不走 native_tools 链路；R020b 仅 native_tools 路径
- 来源：用户 2026-04-26 实际报错 + DeepSeek 官方文档
- 最后确认：2026-04-26

## R022 · reasoning 字段按 provider 分支翻译
- 思考请求体在四个 provider 下采用不同形态，**禁止**用单一字段名跨家发送：
  - **openrouter**：`reasoning:{effort,exclude:false}`（OpenRouter 内部按底层模型再翻译）
  - **openai**：`reasoning:{effort,exclude:false}`（o1/o3/gpt-5 系列）
  - **deepseek**：不写 reasoning 字段（DeepSeek-R1 通过模型名激活，多带反而触发某些中转 400）
  - **custom**：`reasoning:{enabled:true}`（向后兼容旧契约，自建/未知中转端点保持原行为）
- 历史 `reasoningDetails` 仅在 provider=openrouter 时回灌请求体的 `reasoning_details` 字段（snake_case）；其他 provider 静默丢弃，避免中转端点拒绝未知字段
- **不靠 baseURL 字符串包含判断**：provider 是显式枚举，由用户在设置中选择或由初次升级时按 baseURL 启发式推断写入
- 来源：用户 2026-04-27 报告"接入 OpenRouter 后开启思考无效"——根因是项目早期发的 `reasoning:{enabled:true}` 字段名 OpenRouter 不识别，静默忽略导致思考从未激活
- 最后确认：2026-04-28

## R023 · OpenRouter 思考连续性多轮回灌
- OpenRouter 路径下，assistant 历史消息的 `reasoning_details` 数组**必须**按原始结构原样回传给下一轮 LLM 调用（不可拍平、不可重排、不可裁剪），否则在多轮 + 工具调用场景下模型会丢失思考连续性
- 段内（agent loop tool_calls sub-turn 之间）：与 R020b 并列——同一段内 push assistant tool_calls message 时既要带 reasoningContent 也要带 reasoningDetails
- 跨段（用户连续发消息）：`Message.reasoningDetails` 持久化，下一轮 `assembleContext` 透传到 `LLMMessage.reasoningDetails`，由 `toOpenAIMessage` 仅在 provider=openrouter 时写入 snake_case 字段
- SSE 解析层除 yield 拍平后的 reasoning 文本事件外，还要并行 yield 原始 reasoning_details 数组事件，让持久化层保留结构
- **范围限定 provider=openrouter**：其他 provider 不需要此路径（DeepSeek 走 reasoning_content；OpenAI o1 服务端管理状态；custom 协议未知）
- 来源：用户 2026-04-27 在阶段 1/2 五问中明确选择"保留思考上下文一起做" + OpenRouter 官方文档 §Preserving Reasoning
- 最后确认：2026-04-28

## R025 · 撤销栈仅覆盖节点移动 / 节点删除
- 入栈范围**仅限**两类动作：`node.move`（拖拽位移结束且 prev≠next）、`node.delete`（删除 API 成功后入栈完整 snapshot）
- **不入栈**：节点新建（`createNode`）、边删除（`deleteEdge`）、分支创建、提炼创建、撰写创建、消息编辑、设置变更——这些动作按 Cmd+Z 无效
- 仅前端单向撤销，**不实现 Redo**（不维护 future 栈），中途产生新动作不需清空 future
- 栈深度 50，超出按 FIFO 淘汰最旧条目；仅内存（不进 zustand persist 白名单），跨会话不保留
- INV-10 守护：`node.move` 撤销后 `positionX/positionY` 必须**精确等于**前值（不取近似）；entry 仅存 prevX/prevY 即可
- INV-3 守护：`node.delete` 撤销恢复的边若是 `branch` 边，`inheritedUntilSequence` 必须从 snapshot 原样写回，不重新计算
- 失败处理：`performUndo` 仅在成功路径调 `popUndoEntry`；网络/服务端可恢复错误保留条目让用户重试；后端 409（id 已存在）属永久错误，弹栈并 toast 告知避免反复尝试
- 输入框焦点（INPUT/TEXTAREA/contentEditable）时 Cmd+Z 不拦截，让浏览器原生输入撤销生效
- 实现位置：前端 `prototype/src/store/canvasStore.ts::undoStack` + `prototype/src/canvas/nodeActions.ts::performUndo` + `prototype/src/App.tsx` 的 pointerUp / keydown 注入；后端 `src/modules/canvas.ts::restoreNode` + `POST /api/nodes/restore`（事务恢复 + 409）
- 来源：用户 2026-05-07 阶段 1/2 五问决策（仅撤销不重做、仅 move/delete 入栈、悬空边保留、深度 50） + domain/02-domain-model.md §1.7 ActionLog / §3.4 reverse_payload
- 最后确认：2026-05-07

## R024 · OpenRouter reasoning_details SSE 累积按 index 合并
- 单个 thinking block 跨多个 SSE 帧 delta 推送（同一 `index`，不同帧分别带 `type/text/signature` 子集）；累积层**必须**按 `index` 合并增量到同一数组元素，**禁止**直接 spread 追加，否则同一 block 被拆成多个不完整元素，下一轮回灌时 Bedrock 上游报 `messages.X.content.Y: Invalid signature in thinking block` 400
- 合并语义：同 index 时 `text/data/summary` 累加；`type/id/format/signature` 等其它字段后到"非 null/undefined"才覆盖（排除 null 是为防 OpenRouter 用 null 占位反向清空已签名块）
- 兜底：无 index 或新 index 元素作为新数组元素追加，保留旧"按帧追加"行为给 mock 与未来非 Bedrock 协议变体
- 实现位置：`src/modules/_utils.ts::mergeReasoningDeltas`；`accumulateStreamDelta` 与 `agent.runOneLLMRoundStream` 的 reasoning_details 分支均必须经此函数
- 来源：用户 2026-05-07 报错"OpenRouter 思考模型 400 Invalid signature in thinking block"——根因为 SSE 累积按帧 spread 把 Anthropic Claude thinking block 拆成多个无 signature 元素
- 最后确认：2026-05-07
