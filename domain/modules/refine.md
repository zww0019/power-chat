# 提炼模块（refine）

## 职责
将 N 个源节点的对话内容综合为一份结构化纲要，输出到一个新的提炼节点。

## 核心流程
1. POST /api/refine 接收 sourceNodeIds + intentQuestion → 创建 refined 节点 + N 条 refine_input 边 → 注册一次性 token
2. 客户端凭 token 调 GET /api/refine/stream/:token → SSE 流式拉取
3. 服务端用 runAssistantStream 消费 LLM 流，把累积内容写入 refined 节点的单条 assistant message

## 关键不变量
- INV-2 提炼节点继续对话时不展开 inbound（在 conversation.assembleContext 守卫）
- INV-4 refine_input 边的 child 必须是 refined 类型节点
- token 一次性使用（消费后立即从 pendingTasks 删除），30 秒过期

## 输出强制结构（R011 / D008）
LLM 输出必须含四个全角中括号 marker：
- `【核心结论】`
- `【关键论据】`
- `【未解决 / 待验证】`（**不可省略**——产品对用户的诚实承诺）
- `【可能的下一步】`
总长 ≤ 400 字。

## 与 LLM 的交互约束（R010）
- system prompt 严格遵守视觉规范文档 §4.2（REFINE_SYSTEM_PROMPT）
- temperature=0.3（要稳定、结构化）
- 不携带任何对话历史，独立写作任务
- user message 拼装两种模式：
  - 模式 A（intentQuestion 有）：`请基于以下材料，回答这个问题：「...」`
  - 模式 B（intentQuestion 空）：`请基于以下材料，做综合性提炼。`

## 提炼节点 title（E009）
- 在 createRefine 时即设为 "提炼·N 节点"，N 为源节点数
- 不再被 LLM 输出首行覆盖（首行固定是 `【核心结论】`）
- 折叠态卡片直接显示该 title 作为 meta 行

## 递归提炼脱敏（E010）
- 把已有的 refined 节点作为新一轮提炼的源时，源节点 title 可能含"提炼·"前缀
- assembleRefineInput 拼装时检测此前缀并替换为 `材料 N`，避免内部命名透传到 LLM 输入

## 重新提炼（Q5 / D008）
- 由前端 ⟳ 按钮触发（performRetryRefine in nodeActions）
- 复用当前提炼节点的源节点 + intentQuestion=null
- 后端 createRefine 总是产出新节点（不替换原节点），用户可手动删旧节点
- 旧节点保留作为对比副本

## 与其他模块的关系
- 上游：调 settings 取 llmModel/thinkingModeEnabled
- 上游：调 llm-client.streamChat（设 isRefineTask: true 让 mock 用 REFINE_RESPONSE fixture）
- 横向：通过 _utils.runAssistantStream 与 conversation 共享流式消费协议
- 下游：通过 canvas.createNode / createEdge / markStreaming 等管理节点状态
