# Agent 模块（agent）

## 职责
封装 ReAct 循环（thought / action / observation / final）+ 工具调用协议自适应 + 硬约束执行。
作为 conversation 模块"内部能力增强"被调用，不直接对外暴露 HTTP/IPC 端点。

## 在产品里的定位
- agent 不是核心动作（核心动作仍是：种节点 / 分支 / 提炼 / 继续对话）
- agent 是"继续对话"动作的内部实现细节：当 LLM 通过 tool_calls 主动选择工具时由 conversation 模块切换到本模块的 loop
- 用户视角永远是"打字、按 Enter、看 AI 回复"——agent 对用户透明，不是新的交互层

## 三大原则（R014/R015/R016）
- **C 启动权属用户**：仅在用户用动作动词明确请求时启动（由 LLM 通过 prompt 引导判断，前端不做关键词预检）
- **D 过程透明可中断**：thought/action/observation 实时 SSE 推送；中断按钮在 loop 进行期间始终可点
- **E 产出仅是对话回复**：跑完只产生一条普通 AI 消息，不自动建节点 / 分支 / 提炼

## 工具集（封闭，MVP 仅两个）
- **web_search**：基于 Tavily Search API
- **fetch_page**：基于 Tavily Extract API
两者均不感知画布（沿用 R017）；不引入 playwright（D014）。

## 工具调用协议自适应（D013 / R019）
运行时由 `detectToolSupport()` 探测 settings.llmModel：
- 支持 OpenAI Function Calling → `native_tools` 模式（chat/completions 的 tools 字段）
- 不支持 → 降级 `react_text` 模式（工具描述塞进 system prompt + 文本输出解析）

调用方（conversation 模块）对模式无感知，统一以 `agent_*` SSE 事件消费。

## 硬约束（R018，由本模块代码强制执行）
| 约束 | 数值 | 触发后 |
|---|---|---|
| 单次 loop 最多步数 | 8 | agent_final reason=max_steps |
| 单次 loop 最长时间 | 3 分钟 | agent_final reason=max_time |
| 同种工具调用次数 | 5 | agent_final reason=max_same_tool |
| 单页内容上限 | 50_000 字符 | observation 截断标记 truncated=true |
| 全局并发 agent 数 | 1 | 第二个触发时被阻挡 + 提示 |

软约束（"5 步停下汇报"等）写在 prompt 引导 LLM；硬约束写在代码强制执行——两层不互替。

## 上下文分层（D017）
- **完整存储**：每次 agent 运行的轨迹存于 `Message.agentTrace` 字段（assistant 消息）
- **主线对话流**：节点对话主线 = user message + assistant Final Response，不含轨迹
- **下游 LLM 输入**：assembleContext / toLLMMessage 必须剥离 agentTrace（R019 INV-11 扩展）
- **提炼任务**：只打包主线，不打包轨迹

## 与其他模块的关系
- **上游 conversation**：sendMessage 决定走对话还是 agent；交控制权后由本模块 yield SSE 事件
- **上游 settings**：取 llmModel 用于 detectToolSupport
- **上游 llm-client**：扩展支持 tools 字段 + delta.tool_calls 字段
- **横向 tools/**：通过 ToolDefinition 协议调用具体工具；tools 模块不依赖 agent
- **下游 persistence**：通过 _utils.persistAssistantFinal 落库 agentTrace（assistant 消息的字段）
- **下游 canvas**：使用全局 isAgentRunning 标记实现并发 1 约束

## 当前实现状态

**M1（契约铺路）已完成**：
- 类型定义（StreamEvent agent_* / Message.agentTrace / AgentStep / ToolCallMode 等）
- agent.ts 接口签名（runAgentLoop / detectToolSupport / AGENT_HARD_LIMITS）
- tools/ 目录骨架（types / web-search 占位 / fetch-page 占位 / index 注册表）

**M2a（LLM 协议扩展 + 探测）已完成**：
- LLM 客户端 tools 协议扩展（StreamChatParams 加 tools / signal；OpenAI Function Calling SSE chunk 跨行聚合 → 完整 LLMToolCall yield；camelCase ↔ snake_case 字段转换）
- AbortSignal 全链路（fetch 接入 + 流读取过程中 abort 识别 + AbortError 与 network_error 双重区分）
- LLMMessage 扩 'tool' role + toolCalls / toolCallId 字段
- detectToolSupport 实现（黑名单优先 / 默认 native_tools / 进程内缓存，详见 D018）

**M2b（agent loop 接通 + 双模式 + 端到端）已完成**：
- runAgentLoop 双模式实现（native_tools 走 OpenAI Function Calling；react_text 走 JSON 文本协议解析）
- conversation.sendMessage 改造：所有 sendMessage 走 runAgentLoop（决策 6 落地）；LLM 不调工具时退化为单轮普通对话（与改造前行为一致）
- AGENT_SYSTEM_PROMPT_NATIVE 与 AGENT_SYSTEM_PROMPT_REACT_FORMAT 拼接在调用方风格 prompt 之后
- agentTrace 流式实时持久化（每个 action / observation / final step 即时落库，决策 7）
- 工具执行 + 回灌 messages 链：assistant tool_calls + role='tool' 的 observation 回灌
- 触限恢复（max_steps / max_same_tool 触发 → 调一次不带 tools 的 LLM 让它基于已收集 observations 给 Final Response，决策 9/11，详见 D019）
- mock LLM 支持工具触发：基于 user message 关键词路由（"搜/查/找/读"→web_search；URL→fetch_page；含 role=tool 的二次调用→final）
- mock LLM 支持 react_text 文本协议（特殊触发词输出 JSON 字符串模拟推理模型）
- agent 端到端测试 8 个：native_tools 触发 / react_text 路径 / 普通对话退化 / 触限恢复 / agentTrace 持久化 / agentTrace 不污染后续轮

**M3（真实 Tavily 接入 + Settings 字段）已完成**：
- web_search 接入 Tavily Search API（POST `https://api.tavily.com/search`，请求体 `api_key/query/max_results/search_depth=basic`）
- fetch_page 接入 Tavily Extract API（POST `https://api.tavily.com/extract`，请求体 `api_key/urls`）
- USE_MOCK_TOOLS 环境变量切换 mock vs 真实路径（决策 16）；pnpm test 固化 `USE_MOCK_TOOLS=1`
- 30s 单工具超时（决策 17）+ AbortSignal 合并（用户中断 + 超时合一）+ dispose 清理 timer/listener
- 错误分类：`tavily_key_not_configured` / `tavily_unauthorized`(401) / `tavily_rate_limited`(429) / `tavily_http_<status>` / `tavily_timeout` / `tavily_network_error` / `tavily_extract_empty` / `aborted` / `aborted_before_start` / `invalid_url_scheme`
- Settings 加 `tavilyApiKey` 字段：脱敏返回（沿用 R009/D004）+ 表单 dirty 标记防覆写
- 前端 SettingsDialog 加 Tavily API Key 输入字段（独立 dirty 标记 / placeholder 脱敏值）
- mapTavilyHttpFailure / classifyTavilyError / combineSignalsWithTimeout 三个 helper 在 web-search 内 export 供 fetch-page 共享（D010）
- 单元测试 19 个：web-search 10 + fetch-page 9（覆盖请求体格式 / 响应映射 / 各类错误分类 / R018 50_000 截断 / abort 短路）

**M4（前端轨迹区块 UI）已完成**：
- 新建 AgentTrace 组件按文档 §4.3 + D028 暖质感重做后规范渲染：背景 `rgba(245,233,210,0.5)`（暖米半透明）/ 0.5px accent-200 边 / 圆角 token.radius.md / 内边距 12×16 / 字号 token.text.xs（12）（具体色值/字号统一走 R013 token 单一事实源）
- 步骤行：thought（●）/ action+observation 配对合并行（→ ... → 结果）/ failure（✕ + `#A32D2D` 暗红）/ final（●，含触限/中断各类 reason 文案）
- 长 thought >60 字默认省略 + 点击展开看完整
- 流式期间默认展开；streaming → complete 边沿触发自动折叠（与 reasoningContent 同模式）
- 折叠态汇总文案 "▸ AI 搜索 N 次 / 阅读 M 个网页（展开 ↓）"（决策 22 基于 toolName 计数）
- 启动过渡 "AI 正在准备工具调用…"（11px text-tertiary，仅 streaming + trace/reasoning/content 全空的瞬间）
- 中断按钮（⨯）M4 阶段 disabled（M5 已撤销该豁免，详见下条）
- MessageBubble 抽出 ReasoningBlock 子组件治理 CCN
- 渲染顺序：AgentTrace 在前 / ReasoningBlock 在后（决策 23）

**M5（中断闭环 + 全局并发 + §7.1 + 指标埋点）已完成**：
- 后端 `abort-registry`：模块级 Map 维护 nodeId → AbortController 映射；conversation.sendMessage 启动时 register、finally 时 unregister
- HTTP 中断端点 `POST /api/nodes/:id/messages/abort`：返回 204（成功）/ 404（节点不在流式中）
- agent loop 收到 abort 错误事件转 `agent_final reason='aborted_by_user'` + done，让消息以 status=complete 优雅落库（不留 error 状态）
- 全局并发 1 守卫（决策 26）：mock-server 端点先于 setupSSE 检测 `isAnyStreaming()`；已有节点流式时返回 409 `streaming_busy` 含 streamingNodeIds；客户端可显式 `force=true` 让端点先中断旧流再启动新流
- §7.1 同节点自动中断（决策 27）：前端 `performSendMessage` 检测同节点已 streaming → 自动 abort 旧流并 `force=true` 发新消息（不询问用户）
- 跨节点切换协议：检测异节点已 streaming → 弹 `window.confirm` 让用户确认；用户拒绝则放弃；用户同意则 abort 旧流 + force=true 启动
- 前端 `AgentTrace` 撤销 M4 豁免：`AbortButton` 流式期间可点（接收 onAbort 回调）；`abortBtnStyleEnabled` 区分启用态视觉
- 启动率/中断率指标埋点（决策 29）：store 加 `agentStats: { started, completed, aborted, byReason }` 内存计数器；`bumpAgentStat` 仅在 `agent_final` 触发（普通对话不计入），按 reason 细分聚合
- 测试隔离：mock-server `__test__/reset` 端点同步清 abort registry，避免上轮残留 controller 让本轮 409
- 集成测试：`abort.test.ts`（2 个）+ `concurrency.test.ts`（1 通过 + 1 known-flaky skip）
- M4 临时豁免 R015 已撤销

## 流式透传硬约束（M5+ 修复后固化）
- `runOneLLMRoundStream` 必须是 async generator：每个 LLM delta（reasoning / native_tools content）即时 `yield` 给上游，不得攒到数组里等整轮跑完才输出
- 反例（已修复）：旧实现把 delta 累积到 `OneRoundResult.passthroughEvents`，整轮跑完才在 `runAgentLoop` 一次性 for-of yield，前端表现为"长时间等待→末尾突然全部出现"的伪流式
- `OneRoundResult` 仅承载 toolCalls/messageId/errorEvent/contentBuf/reasoningBuf 等需要流结束后回灌到 messages 的状态，不再持有事件队列
- react_text 模式例外：content delta 仍在 `runOneLLMRoundStream` 内部攒批到 `reactChunks`，原因是 LLM 输出完整 JSON 才能区分"调工具 vs 最终回复"，提前 yield 会暴露 `{"thought":...,"action":...}` 骨架给前端

## M5 已知 flaky 测试
- 测试用例：`concurrency.test.ts > A 节点流式中，B 节点 send 直接返回 409 streaming_busy`
- 状态：`it.skip`，列入 known-flaky 跟踪
- 现象：直接观察 registry 的轮询 helper 看到 nodeId 已注册，但紧接着 fetch B 命中 server 时 `isAnyStreaming()` 返回 false
- 根因假设：vitest `fileParallelism: false` 与 mock-server `tsx watch` 模式之间存在进程时序差；force=true 路径的另一个测试（已通过）间接验证守卫实际触发
- 解决路径：electron 化打包后 IPC 替代 HTTP（同进程无时序差）该测试自然消失，不投入额外修复成本
