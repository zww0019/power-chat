# 对话模块（conversation）

## 职责
节点内消息的发送与流式回复 + 父链上下文组装 + 分支动作 + 节点标题异步生成。

## 核心流程
1. 用户发消息 → 创建 user message + assistant 占位 → 标记节点流式中
2. 组装 LLM 上下文（assembleContext 守卫 INV-1/2/3/11）
3. 调 LLM 流式接口 → 通过 runAssistantStream 逐 chunk 累积 + 持久化
4. SSE done 时收尾 → 触发标题节流（D006）

## 关键不变量
- INV-1 节点上下文 = 该节点 messages + 入边继承内容
- INV-2 提炼节点不展开父链（assembleContext 内 type 判断）
- INV-3 分支边 inheritedUntilSequence 不可变（在分支动作时写入 fromMsg.sequence）
- INV-11 reasoningContent 不进入下一轮 LLM 调用（toLLMMessage 强制剥离）
- INV-7 流式中节点不可删除（streamingNodes 内存 Set 守卫）

## 与 LLM 的交互约束（R010）
- system prompt 严格遵守视觉规范文档 §4.1（CONVERSATION_SYSTEM_PROMPT）
- 不得出现"画布"/"节点"/"分支"/"提炼"等产品概念
- temperature=0.7（保留对话活力）

## 标题生成（D006 / R012）
- 节流：每节点对话累计满 6 条 message（≈3 轮）触发一次
- 用 `settings.llmFastModel ?? settings.llmModel`，max_tokens=30 / temperature=0.2
- 失败静默（E008），不影响主流程
- 成功通过 SSE 'title' 事件推送给前端，前端 store 同步更新
- **事件顺序硬约束**：title 事件必须在 'done' 之前 yield。客户端（client.ts runStream）收到 done 即 unsubscribe，trailing 事件会被 IPC 路径丢弃；done 必须是流的最后一个事件

## 分支动作
- 子节点位置：父节点右侧偏移 +440px；同父节点已有 N 个 branch 出边时，新子节点 Y 向下错开 N×单位偏移，避免多次"从这里分支"在画布上完全堆叠
- 分支边的 inheritedUntilSequence 写入 fromMsg.sequence，不可变（INV-3）
- 子节点是新 dialogue 节点，messages 为空
- 同一父节点同一消息可被多次分支，每次都产生独立子节点和独立 edge（无去重）

## 截断式删除消息（用户编辑触发）
- 用户编辑某条 user 消息提交后："删除该消息及之后所有消息 + 用编辑后内容走标准 sendMessage 重新触发 LLM"
- 后端 `truncateMessages(nodeId, fromSequence)` 删除该节点 sequence ≥ fromSequence 的所有 messages
- 三层守卫顺序：(a) 节点流式中拒绝（沿用 INV-7 思路，复用 StreamingNodeError）；(b) 被分支引用拒绝（R021）；(c) 实际删除（并行 delete）
- sequence 由删除后剩余消息的"最大 + 1"接续——不覆盖旧 id，新 user 消息获得新 id 和新 sequence
- 仅支持编辑 user 消息，不支持 assistant 消息编辑/重生成（v1 范围限定，避免重生成时 agentTrace/reasoningContent 等字段的语义复杂度）

## 与其他模块的关系
- 上游：调 settings 取 llmModel/llmFastModel/thinkingModeEnabled
- 上游：sendMessage 把 LLM 调用统一交给 agent.runAgentLoop（M2b 起，决策 6）；refine 仍直接调 streamChat（提炼任务不需要工具）
- 横向：通过 _utils.runAgentAssistantStream 消费 agent loop 流（agent 版协议，含 agentTrace 累积）；refine 用 _utils.runAssistantStream 共享对话版协议
- 下游：通过 canvas.patchNode / markStreaming 等管理节点状态

## 与 agent 模块的边界（M2b 起）
- conversation 负责：上下文组装（assembleContext） + 创建占位 message + 标记 streaming + 拼装 CONVERSATION_SYSTEM_PROMPT + 标题节流
- agent 负责：决定是否调工具、调几轮、触限恢复、agent_* 事件 yield、AGENT_SYSTEM_PROMPT 追加
- 普通对话路径（LLM 不调工具）：runAgentLoop 第一轮收到 content + done → 立即 yield done 退化为单轮，行为与 M2 改造前完全一致
