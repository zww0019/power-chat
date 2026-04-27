# 对话模块（conversation）

## 职责
节点内消息的发送与流式回复 + 父链上下文组装 + 分支动作 + 节点标题双轨生成（自动 + 主动）。

## 核心流程
1. 用户发消息 → 创建 user message + assistant 占位 → 标记节点流式中
2. 组装 LLM 上下文（assembleContext 守卫 INV-1/2/3/11）
3. 调 LLM 流式接口 → 通过 runAgentAssistantStream 逐 chunk 累积 + 持久化
4. SSE done 之前 → onComplete 钩子检查"消息条数 ≥ 6 且 % 6 === 0"，命中则调 regenerateNodeTitle 并 yield title / title_error 事件（D006 自动轨）

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

## 标题生成（R012 · 双轨制）
**自动轨**：
- 触发：`sendMessage.onComplete` 内检查 `messages.length >= 6 && messages.length % 6 === 0`
- 命中后调 `regenerateNodeTitle`，成功 yield `{ type: 'title', nodeId, title }`，失败转简化 code 后 yield `{ type: 'title_error', nodeId, error }`
- 事件顺序硬约束（E016）：title / title_error 事件必须在 done 之前 yield
- **触发条件用 messages.length 而非 sequence 偏移**——旧的 `(nextSeq + 2) % 6` 在节点经过截断式删除后会失效（详见 E008 / D006）

**主动轨**：
- 触发：节点 header / 折叠卡 / 大屏 Modal 标题旁的 ↻ 图标按钮（hover 显示），用户点击
- 入口：独立 `POST /api/nodes/:id/regenerate-title`（非 SSE，一次性返回 `{title}`）

**共用核心**：
- 实现：`conversation.regenerateNodeTitle(nodeId)` 用 `settings.llmFastModel ?? settings.llmModel`，max_tokens=30 / temperature=0.2
- 永远强制重新生成：两轨都不判断 `node.title` 是否已有值
- 失败领域错误：`NodeNotFoundError` / `NoMessagesForTitleError` / `TitleGenerationFailedError` / `NotConfiguredError`
- `classifyTitleError` 把异常归类成简化 code（empty_node / not_configured / llm_failed / not_found / unknown）
- 前端 `titleErrorMessage` 统一映射 toast 文案，自动轨与主动轨无文案漂移

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

## AI 消息复制（仅前端能力）
- assistant 气泡 hover 80ms 后左下浮出 `MessageToolbar`，工具栏内含 `📋`（复制）/ `↳`（从这里分支）/ `⑂N`（已派生分支时显示，点击展开浮层）三项 icon 按钮
- user 气泡同样 hover 80ms，右下浮出工具栏，仅含 `✎`（编辑）一项
- 工具栏与按钮的视觉规格统一遵循 R013（透明背景、纯 icon、无胶囊感）
- 复制内容只取 `Message.content`（保留原始 markdown 符号，不剥离），**不包含** `reasoningContent` / `agentTrace`（语义独立字段，沿用 R019 协议无关原则的边界）
- 复制不受 R021 守卫约束（不修改任何数据，与"截断/编辑"语义无关）
- 不给 user 消息提供复制按钮（v1 范围限定）
- 实现走 `navigator.clipboard.writeText` 主路径，失败时回退 `document.execCommand('copy')` 兜底（覆盖 Electron file:// 非安全上下文场景）；成功 `toast.success('已复制')`、失败 `toast.error('复制失败')`
- BranchBadge 浮层 open 时，工具栏强制保持可见（`popoverOpen` 状态由 AssistantBubble 管理）—— 避免鼠标移到浮层上时工具栏带飞 popover

## 与其他模块的关系
- 上游：调 settings 取 llmModel/llmFastModel/thinkingModeEnabled
- 上游：sendMessage 把 LLM 调用统一交给 agent.runAgentLoop（M2b 起，决策 6）；refine 仍直接调 streamChat（提炼任务不需要工具）
- 横向：通过 _utils.runAgentAssistantStream 消费 agent loop 流（agent 版协议，含 agentTrace 累积）；refine 用 _utils.runAssistantStream 共享对话版协议
- 下游：通过 canvas.patchNode / markStreaming 等管理节点状态

## 与 agent 模块的边界（M2b 起）
- conversation 负责：上下文组装（assembleContext） + 创建占位 message + 标记 streaming + 拼装 CONVERSATION_SYSTEM_PROMPT + 自动轨标题节流（onComplete 内检查 messages.length）+ regenerateNodeTitle 函数本身（双轨共用）
- agent 负责：决定是否调工具、调几轮、触限恢复、agent_* 事件 yield、AGENT_SYSTEM_PROMPT 追加
- 普通对话路径（LLM 不调工具）：runAgentLoop 第一轮收到 content + done → 立即 yield done 退化为单轮，行为与 M2 改造前完全一致
