# 边界情况

## E001 · 流式中节点删除被拒
**场景**: 节点正在接收 LLM 流式输出时，用户尝试删除它（按 Delete 键或调 API）
**处理**: 后端抛 `StreamingNodeError` → 路由层映射为 HTTP 409 / IPC 409；前端弹提示"节点正在流式输出，无法删除..."
**原因**: 流式中删除节点会让 stream 写入到一个不存在的目标，污染数据；强制等待用户主动等流结束或刷新页面（流自然中断）

## E002 · 折叠卡片整片皆可点击展开
**场景**: 节点处于折叠态，用户希望点击任意位置展开
**处理**: 整张折叠卡片走拖拽流程，pointerup 时按位移阈值（< 4px）判定是否为单击 → 展开
**原因**: setPointerCapture 后 click 事件不可靠（被吞），统一改用 pointerup + 位移判定；同时不限制点击区域（标题行/消息预览区都能展开），避免出现"半个卡片不响应"的诡异手感

## E003 · apiKey 表单读到的是脱敏值，不能回写
**场景**: 用户打开设置弹窗，apiKey 字段的服务端返回值是 `sk-•••abc1`（脱敏）
**处理**: 表单 input value 始终留空，脱敏值仅作为 placeholder 展示；用户未修改时提交不带 apiKey 字段（服务端合并写入会保持原值）
**原因**: 若直接 `value={apiKey}` 绑定，用户没改而保存就会把脱敏字符串写回 db，永久破坏真实 key

## E004 · 删除快捷键在文本输入控件中失效
**场景**: 用户在节点输入框 / 设置弹窗 input 中按 Backspace 编辑文本
**处理**: 全局 keydown 监听检测 `target.tagName === 'INPUT' / 'TEXTAREA'` 或 `isContentEditable`，在这些控件中跳过删除逻辑
**原因**: Delete/Backspace 在文本编辑场景是字符删除，吞掉会让用户无法编辑

## E005 · SVG 边层不能拦截背景双击
**场景**: 画布的 SVG 边层尺寸高达 20000×20000，覆盖整个可视区域之上；若 SVG 接收 pointer 事件，背景双击创建节点的逻辑会被吞（因为 `e.target` 变成 SVG 而非画布容器）
**处理**: SVG 容器必须显式 `pointerEvents: 'none'`；命中线在 SVG 内单独用 `pointerEvents="stroke"` 打开（SVG 子元素可独立覆盖父级 'none'）
**原因**: 画布交互中"背景"事件（双击创建节点 / pan 拖拽）依赖 `e.target === e.currentTarget` 判定，任何透明覆盖层都不能默认接收事件
**事故记录**: 2026-04-26 实施边删除时，把 SVG 容器的 pointerEvents 误删，导致双击创建节点失效；当天回归并补此条记录

## E006 · 测试 reset 端点会清空真实数据库
**场景**: 集成测试 `beforeEach` 调 `/api/__test__/reset` 清空数据库；若 mock-server 启动时未设 `POWER_CHAT_DB`，默认指向项目根 `.data/db.json` —— 真实用户数据会被冲掉
**处理**:
- 项目根 `package.json` 的 `test` / `test:watch` 脚本必须强制设 `POWER_CHAT_DB=/tmp/power-chat-test.json`，并自动启动隔离的 mock-server
- 任何手动启动 mock-server 跑测试的脚本/CI 都必须沿用此约定
**原因**: `reset` 端点对 NODE_ENV != production 一律开放，且持久层是单进程文件适配器，无法在运行时区分"测试请求"与"用户请求"
**事故记录**: 2026-04-26 一次开发会话中，AI 助手未设隔离环境变量直接跑了 3 次集成测试，导致真实画布的 nodes/edges/messages 全部被清空且无备份可恢复（项目非 git、无 Time Machine、无 APFS 快照）

## E008 · 节点标题生成的双轨制演进（2026-04-27 同日两次迭代）
**历史背景**:
- 旧设计："每 3 轮对话（6 条 message）异步生成标题，失败静默"
- 失败模式 1：触发计数器用 sequence 偏移（`(nextSeq + 2) % 6`）而非实际轮数；节点经历过"消息截断式删除"后，剩余 sequence 跨过 6 的整除位（如最大 sequence=4 后下一轮 nextSeq=5、totalMessages=7、9、11…永远不能被 6 整除），标题再也不会触发
- 失败模式 2：`updateNodeTitle` 被 `.catch(() => null)` 静默吞错；快模型不可达 / apiKey 无权限 / 配置成无效模型时全链路零日志、零提示，用户察觉不到失败

**演进过程**:
1. 第一次修订（2026-04-27 上午）：完全废弃自动触发，改为纯主动按钮——验证了主动轨可行性
2. 第二次修订（2026-04-27 下午）：恢复自动触发，但修掉两个根本 bug，与主动轨形成双轨制并存

**当前处理（双轨制 · D006）**:
- **自动轨**：`sendMessage` 的 `runAgentAssistantStream` 的 `onComplete` 内触发：
  - 触发条件改用 `messages.length >= 6 && messages.length % 6 === 0`（**消息条数**而非 sequence 偏移），从根上规避失败模式 1
  - 失败时把领域异常归类成简化 code 通过新增的 SSE `title_error` 事件透传给前端 toast，**修复失败模式 2**
- **主动轨**：用户点击 ↻ 按钮调 `POST /api/nodes/:id/regenerate-title`
- 共用错误码语义（empty_node / not_configured / not_found / llm_failed / unknown）+ 共用 toast 文案映射（前端 `titleErrorMessage`），无双份漂移

**原因**: 用户主权 + 错误可见原则——双轨同时满足"长期对话节点的保鲜度（自动）"和"用户随时主动控制（主动）"，且任何路径的失败都向用户暴露

## E009 · 提炼节点 title 在创建时定值，LLM 输出不覆盖
**场景**: 提炼任务完成后，LLM 输出首行是 `【核心结论】` 而非可作标题的句子
**处理**: 在 `createRefine` 时即把 title 设为 "提炼·N 节点"（N 为源节点数），后续流式输出完成不再用 contentBuf 首行覆盖
**原因**: 新 prompt 强制四栏结构，首行固定是 marker，不适合作标题；折叠态卡片 meta 行直接显示该 title 已足够辨识

## E010 · 递归提炼时源节点 title 含"提炼·"前缀需脱敏
**场景**: 用户选择一个或多个**已提炼节点**作为新一轮提炼的源（递归提炼）
**处理**: `assembleRefineInput` 拼装 user message 时检测 `node.title` 是否以 "提炼·" 开头，若是则替换为 `材料 N`，避免内部命名透传到 LLM 输入
**原因**: R010 守卫——AI 调用必须对画布产品概念零感知；"提炼·" 是产品内部术语，不应进入 prompt

## E011 · tavilyApiKey 未配置时工具调用的优雅降级
**场景**: 用户用动作动词（"搜一下""读这个网页"）触发 agent，但 Settings 中 tavilyApiKey 为空
**处理**:
- 工具内部检查 `settings.tavilyApiKey`，为空则直接返回 `{ success: false, error: 'tavily_key_not_configured' }`
- agent loop 把这条 observation 回灌为 role='tool' 的 messages，下一轮 LLM 调用让 LLM 自己决定如何告知用户
- LLM 通常会回复"我无法搜索/读取，因为 Tavily key 未配置——请在设置中填写"
**原因**:
- 不在 detectToolSupport / runAgentLoop 顶层拦截（决策 15）：保持"工具自主判定 + agent loop 自然降级"原则
- LLM 给出的提示比固定模板更友好（可基于上下文给具体指引）
- 用户只需在设置弹窗填 Tavily key 即可恢复，路径短

## E012 · 同节点 streaming 中用户连发新消息（M5 / §7.1）
**场景**: 用户在节点 A 的 agent 还在流式回复时，又在 A 节点输入新消息按 Enter
**处理**:
- 前端 `performSendMessage` 检测到当前节点已 streaming → 调中断 API（abort 旧 controller）
- 立即用 `force=true` 调 sendMessage 端点；server 端守卫看到旧流 controller 仍在 registry（abort 异步），force 路径会再次 abort（幂等）确保新流可启动
- 旧流 generator 收到 signal 后 yield `agent_final(aborted_by_new_message)` + done（消息状态 complete + agentTrace 留下中断标记）；新流接管节点 streaming
- 不弹确认（同节点连发是用户对当前对话的修改意图，自动中断符合预期）
**原因**: 用户主权优先于任务完成度；让用户能"打断 AI 重新提问"是核心交互（文档 §7.1 / 原则 D）

## E013 · 跨节点 streaming 中切换发新消息（M5 / 决策 26）
**场景**: 节点 A 的 agent 还在流式中，用户切到节点 B 输入新消息按 Enter
**处理**:
- 前端 `performSendMessage` 检测异节点已 streaming → `window.confirm("节点 A 正在流式回复中。继续将中断它，然后在当前节点开始新的回复，确认吗？")`
- 用户拒绝：放弃当前 send，A 流继续
- 用户同意：调 abort A → 用 force=true 启动 B 流
- 全局并发 1 守卫（R018）保证同一时刻只有一个节点流式
**原因**: 跨节点切换是上下文切换的明确动作，需用户确认避免误中断；同节点连发不要求确认（E012）—— 两条路径的差异由"是否切换上下文"决定

## E014 · DeepSeek-Reasoner agent 工具调用段内必须回传 reasoning_content（D020 / R020b）

**精确触发条件**（三个并列）:
1. 模型 native_tools 模式（非 react_text；deepseek-reasoner 黑名单命中走 react_text 不受影响——但若用户配置非黑名单的支持思考模式 + 工具调用的模型则触发）
2. enableReasoning=true（思考模式启用）
3. 当前 turn 内有 tool_calls（agent loop 调用了工具）

**协议规则**（DeepSeek 官方文档）:
- **跨段**（两个 user 之间无 tool_calls）：assistant 历史 reasoning_content 可省略；传了 API 忽略
- **段内**（两个 user 之间有 tool_calls）：assistant 历史 reasoning_content **必须**回传给所有后续段内调用，不传 → 400 invalid_request_error

**处理路径**:
- 跨段（R020a / conversation 路径）：toLLMMessage 透传 reasoningContent；toOpenAIMessage 写 reasoning_content
- 段内（R020b / agent loop 路径）：runOneLLMRound 累积 reasoning delta 到 reasoningBuf；runAgentLoop push assistant tool_calls message 时携带 reasoningContent
- 协议形态：assistant message 同时含 content + reasoning_content + tool_calls 三字段（与 deepseek 文档示例对齐）

**反例**（两次修复前的 bug 行为）:
- 第 1 版（M5 之前）：toLLMMessage 严格剥离 reasoningContent → 跨段路径无 reasoning_content（DeepSeek 实际跨段忽略所以不直接 400，但段内也无累积 → 段内 400）
- 第 1 版修复（D020 第一轮）：补 toLLMMessage 透传 → 跨段过；但 agent loop 内部段内 sub-turn 仍无 reasoningBuf 累积 → 段内 400 仍存在
- 第 2 版修复（D020 补充修订 / R020b）：agent.ts `OneRoundResult` 加 reasoningBuf；`consumeLLMRoundStream` 累积；`runAgentLoop` push assistant message 携带——段内 400 才真正消除

**事故记录**: 2026-04-26 用户两次反馈实际报 400；当日两轮修复（第 1 版仅修跨段；第 2 版修段内才闭环）

## E015 · LLM 流错误事件必须写入 message UI（D021 配套）
**场景**: LLM 调用失败（context_overflow / 401 apiKey 错 / 网络抖动 / 真实 API 4xx / 5xx）
**处理**:
- 后端 SSE 流 yield `{ type: 'error', error: '...' }` 事件
- 前端 `applyStreamEvent.case 'error'`：
  - `console.error('[stream]', evt.error)`（开发调试可见）
  - `store.markMessageError(asstMsgId, evt.error)`（UI 反馈：把错误说明追加到 message.content 末尾，前缀 `[错误]` 视觉区分；message.status 置 `'error'`）
- MessageBubble 通过现有 MarkdownContent 渲染，错误说明自动显示在节点内
**反例**（修复前的 bug 行为）:
- 仅 `console.error` 打印到 DevTools，节点 UI 完全静默；用户看不到任何反馈，以为是网络卡顿
- 实测 2026-04-26 用户报"electron 前端控制台报错但界面没看到提示"
**原因**: 用户主权原则——错误必须可见可决策；DevTools console 是开发工具，普通用户不会打开
**事故记录**: 2026-04-26 与 D021（撤销 token 前置守卫）配套修复

## E016 · `done` 事件之后的 trailing 事件会被前端 IPC 丢弃
**场景**: 后端 generator 在 yield `done` 之后才 yield 副作用事件（如自动标题生成的 `title` / `title_error` 事件）
**处理**:
- 后端 `_utils.runAgentAssistantStream` 的 done 分支顺序固定为：`persistFinal → await onComplete() → yield extra → yield done`
- `done` 必须是流的最后一个事件
**历史背景**:
- 2026-04-26 修复"加入工具能力后节点标题就一直失效"：旧顺序 `yield done → await onComplete → yield extra`，前端 `client.ts:runStream` 收到 `done` 立即 `unsubscribe()`，紧随其后的 `title` 事件在 Electron IPC 路径下被彻底丢弃
- 2026-04-27 同日两次迭代：先废弃自动触发（移除 onComplete 参数），后又恢复自动触发并重新引入 onComplete；本约束在恢复后再次成为硬约束
**原因**: IPC 监听器一旦 unsubscribe 就不再接收任何事件；后端 generator 是"推"语义，前端 once-on-done 是"拉"语义，二者只能通过事件顺序保证不冲突

## E017 · agent 单轮 LLM 流式事件不得攒批
**场景**: agent loop 单轮内消费 LLM SSE 流时，把所有 reasoning/content delta 收集到数组，整轮跑完才回到 runAgentLoop 一次性 yield
**处理**:
- `runOneLLMRoundStream` 必须是 async generator，每个 LLM delta 即时 `yield`
- `OneRoundResult` 不持有事件队列，仅承载流结束后回灌 messages 所需的 toolCalls/messageId/buf
**反例**（修复前的 bug 行为）:
- 旧实现 `consumeLLMRoundStream` 把 reasoning/content 事件 push 到 `OneRoundResult.passthroughEvents` 数组
- `runAgentLoop` 在 `await runOneLLMRound(...)` 返回后才 `for-of round.passthroughEvents yield evt`
- 前端表现：长时间无任何流式回包 → 末尾突然全部出现 → done，与"无流式"完全等价
- 思考模式（reasoning chunk 数倍于普通 content）下感知最强烈
- 实测 2026-04-26 用户报"思考模式流式响应卡顿，AI 回复时长时间不动突然大面积出现"
**原因**: async generator 的延迟语义——`await consumeAll(...)` 模式让所有事件在调用方 await 处被一次性收集，破坏了"推"流的实时性

## E007 · 三种选择状态切换时必须互清
**场景**: 用户在已有 active node 时点击边，或在选中边时 Shift+点节点
**处理**: 任一选择动作（setActiveNode / toggleSelectNode / setSelectedEdge）都在 store 内主动清空另两种状态
**原因**: Delete 键根据"当前激活的选择类型"决定删除目标，若同时存在 active node 和 selected edge，行为定义不明确（按优先级解决会让用户困惑）

## E019 · 编辑被分支引用的用户消息会破坏子分支继承上下文
**场景**: 用户编辑父节点中 sequence=N 的 user 消息时，要删除 sequence ≥ N 的所有消息再重发。若任一子分支的 `inheritedUntilSequence ≥ N`，删除会让子分支再次发消息时拿到的"父链上下文"凭空缺失部分内容（assembleContextWithLimit 静默截短），LLM 看到残缺的对话历史
**处理**:
- 前端 UI 层先挡：`UserBubble` 编辑按钮检查 `selectIsMessageReferencedByBranch`，被引用时 disabled + tooltip 说明
- 后端 API 兜底：`truncateMessages` 必查所有出边 branch，命中即抛 `MessageReferencedByBranchError`，HTTP 映射 409 `branch_referenced` + `childNodeIds` 列表（防竞态：用户编辑期间另一会话刚好创建分支引用了该消息）
- 不级联删子分支：用户数据风险大，不能为方便编辑而删除其他节点
- 不 silent 截短：违反 INV-3 引用语义
**原因**: INV-3 保证的是"分支边截止 sequence 不可变"，但**不保证消息内容不可变**也不保证消息存在。任一对父节点 message 的破坏性操作都需要分支引用守卫——这是 R021 的核心动机

## E020 · mock-server 与 Electron IPC 是两份并行路由表（漂移风险）
**场景**: 新增/修改一个 API 端点时，只在 `mock-server/src/server.ts` 加路由，浏览器 dev 模式 + 集成测试都正常通过；但 Electron 桌面应用走 `electron/src/ipc.ts` 的 IPC router，找不到端点抛 `404 No route for METHOD /api/...`
**处理**:
- 新增/修改任何 API 端点必须**同步改两处**：mock-server (HTTP) + electron/src/ipc.ts (IPC)
- 错误映射（HTTP status / error code / message 文本）必须严格对齐，否则前端用 `String.includes(errorCode)` 检测会在两条路径行为不一致
- 带 querystring 的端点（如 `?fromSequence=N`）：电 IPC 路径需在 dispatch 入口用 `URL` API 分离 pathname + searchParams，路由模式（含 `$` 锚）只匹配 pathname
**原因**: Stage 5 mock-server 是早期产物（HTTP API 浏览器 dev + 测试基础设施）；Stage 7 切到 Electron 后 IPC 桥独立成 ipc.ts。两者都委托到 `src/modules/*` 同一份业务逻辑，"业务漂移"风险有限，但**路由声明会漂移**。集成测试只覆盖 HTTP 路径，IPC 路径的回归只能靠手动验收
**事故记录**: 2026-04-27 实施"用户消息编辑+重新生成"时，新增 `DELETE /api/nodes/:id/messages` 只在 mock-server 加，Electron 用户编辑按回车直接 404；当天补全 ipc.ts 同款路由 + URL API 解析。改进路径（未实施）：抽共享 `src/contracts/routes.ts` 让两端引用同一份路由声明，从根上消除漂移

## E018 · 画布 transform 层内不能用 Element.scrollIntoView
**场景**: 分支跳转时把目标消息滚到视口——目标消息在节点内的 `overflow:auto` 容器里，节点又是 `position:absolute` 嵌在画布的 `transform: translate+scale` 层下
**处理**: 改为手动定位最近的 `overflow-y:auto/scroll` 祖先（节点的消息列表容器），用 `getBoundingClientRect` 计算相对偏移后调 `container.scrollTo({top, behavior:'smooth'})` 只滚它一个；遍历时校验 `scrollHeight > clientHeight` 避免误判未溢出的容器
**原因**: `Element.scrollIntoView` 会让**所有**可滚动祖先链都滚动以使元素可见——包括 body / 画布根容器。在 transform 层内，浏览器按渲染后的实际位置计算可见性，会把 body 一起滚走，表现为"父节点顶部被裁切 + 画布下方出现空白裂缝 + minimap 视口框漂移"
**事故记录**: 2026-04-27 实施分支一键跳转时第一版用 `scrollIntoView({block:'start'})`，用户截图反馈跳转后画布严重错位；当天定位根因并切换为手动滚最近 overflow:auto 祖先方案

## E021 · OpenRouter 思考字段名错配会被静默忽略（D029 根因）
**场景**: 给 OpenRouter 发的请求体写 `reasoning:{enabled:true}` 而非 `reasoning:{effort:"medium"}`——OpenRouter 不识别 `enabled` 字段，会按"未传 reasoning 配置"处理，思考从未激活；但请求 200 OK，前端看不到任何报错信号
**处理**: provider 路由分支翻译——`reasoning` 字段格式由 provider 决定（详见 R022），不要假设单一字段名能跨家通用；新增 provider 时必须先查目标家协议文档确认字段
**原因**: OpenAI 兼容协议各家在"基础 chat/completions" 维度兼容，但思考相关字段是各家私有扩展；OpenRouter 自己也在做"翻译层"——本侧发什么字段决定了 OpenRouter 翻不翻、怎么翻
**事故记录**: 2026-04-27 用户报告"接入 OpenRouter 后开启思考无效"——实际请求成功但思考从未激活；并存的 SSE 解析侧只读 `delta.reasoning_content`（DeepSeek 私有字段），即便 OpenRouter 真返回思考也读不到。两个根因叠加导致用户看不到任何思考内容

## E022 · 前端乐观消息 ID 与后端真实 ID 不同步会让 branch / edit 失败
**场景**: 用户发送一条新消息，AI 回复完成后立即点击该 AI 消息的"分支"按钮，后端返回 400 fromMessageId not found in parent
**处理**: 后端在 user 消息持久化后立即 yield `user_persisted` 事件下发真实 ID（必须早于第一帧 reasoning / content）；assistant 消息复用已有 `done` 事件的 messageId 字段；前端在两个事件到达时把 store 中的占位 ID 替换为真实 ID，闭包持有的占位变量同步更新
**原因**: 前端为让 UI 立即显示 user 气泡和 assistant 流式光标，乐观生成消息 ID 写入 store；后端持久化时为保证 ID 唯一性按"时间戳 + 随机"另行生成。两端 ID 格式都不相同，store 里的乐观 ID 在后端查无此项——任何按 ID 查后端的操作（branch / edit / truncate）都会失败
**事故记录**: 2026-04-28 用户对刚发完的 AI 消息点分支即报 400 not_found；根因是 SSE 协议从未把后端 user 消息真实 ID 回传前端，已存的 `done.messageId` 也被前端 finalize 时忽略。本次补全协议（新增 user_persisted + done 内做 ID 替换）后链路闭环
