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
- 高频后台静默调用，每节点对话累计每 3 轮触发一次
- 必须是名词性短语，不允许动词起头（"东南亚消费习惯差异" √；"讨论了东南亚消费习惯差异" ×）
- max_tokens 硬上限 30
- 来源：视觉规范文档 §4.3
- 最后确认：2026-04-26

## R013 · 视觉硬约束
- 节点边框 0.5px；圆角 8px；折叠态宽 200px / 高 56-60px；展开态宽 360px
- 节点 fullscreen 形态（大屏 Modal）：宽 `min(70vw, 900px)`，高 `min(80vh, 800px)`，居中覆盖；遮罩 `rgba(0,0,0,0.4)`；header 高 48px；body padding `16px 24px`；内部字号 14px（比展开态 13px 略放大）
- 字号阶梯仅 22 / 16 / 14 / 13 / 11 / 10 六档（fullscreen 引入 14）；weight 仅 400 / 500（禁用 600+）
- 配色 token：对话节点 `#FFFFFF + #E5E3DA`；提炼节点 `#FAEEDA + #EF9F27 + #412402 + #BA7517`；活跃边框 `#185FA5`；连线 `#C8C6BD`；页面背景 `#F1EFE8`
- 边的几何为 cubic bezier，控制点放在两节点垂直中点
- 网格 22px 圆点，透明度 4–5%
- 全局预览（minimap）：右下角 `position:fixed`，180×120，背景 `rgba(255,255,255,0.92)`，节点矩形按 bbox 等比缩放（折叠估 200×60、展开估 360×360），视口框边框 `#185FA5`、填充 `rgba(24,95,165,0.08)`
- 来源：视觉规范文档 §一/二/三 + 2026-04-26 fullscreen/minimap 增量
- 最后确认：2026-04-26

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
