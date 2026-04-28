// 共享类型定义。源头是 docs/02-domain-model.md + docs/04-api-contract.yaml。
// 此文件被 mock-server / 未来的 Electron 主进程 / tests 共同引用。
// 注意：与 prototype/src/types.ts 保持完全一致（Stage 7 抽象成同一份）。

export type NodeType = 'dialogue' | 'refined';
export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'complete' | 'streaming' | 'partial' | 'error';
export type EdgeKind = 'branch' | 'refine_input';

export interface Canvas {
  id: string;
  viewportX: number;
  viewportY: number;
  viewportZoom: number;
  createdAt: string;
  updatedAt: string;
}

export interface Node {
  id: string;
  canvasId: string;
  type: NodeType;
  positionX: number;
  positionY: number;
  width: number;
  collapsed: boolean;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  lastFocusedAt: string | null;
}

export interface Edge {
  id: string;
  parentNodeId: string;
  childNodeId: string;
  edgeKind: EdgeKind;
  inheritedUntilSequence: number | null;
  createdAt: string;
}

export interface Message {
  id: string;
  nodeId: string;
  role: MessageRole;
  content: string;
  // 可选：前端创建占位 message 时常省略；后端流式时显式赋值
  reasoningContent?: string | null;
  sequence: number;
  status: MessageStatus;
  // 可选：当前 MVP 后端总是写 false；未来"中断恢复"功能会写 true
  wasResumed?: boolean;
  // 可选：assistant 消息的 agent 调用轨迹（thought/action/observation/final 序列）。
  // null 或 undefined 表示该消息未触发 agent；非空数组 = agent 模式产物。
  // 与 reasoningContent 同样受 INV-11 守卫：不会回灌到下游 LLM 调用。
  agentTrace?: AgentStep[] | null;
  // 可选：OpenRouter / OpenAI 推理模型回传的结构化 reasoning_details 数组。
  // 仅供下一轮请求按 provider=openrouter 分支回灌给 LLM 维持思考连续性，不参与渲染——
  // 渲染统一走 reasoningContent（已由 SSE 解析层把各家协议拍平为纯文本）。
  reasoningDetails?: ReasoningDetail[] | null;
  createdAt: string;
}

// OpenRouter 标准化的 reasoning_details 元素。type 字段在多家协议下取值不同，
// 仅作透传：本地不解析其内部结构，原样回灌即可。
export interface ReasoningDetail {
  type: string;
  id?: string | null;
  format?: string;
  index?: number;
  text?: string;
  summary?: string;
  data?: string;
  signature?: string | null;
  [key: string]: unknown;
}

export interface Settings {
  llmBaseUrl: string;
  llmModel: string;
  // 可选：高频轻量调用（如节点标题生成）使用的快模型；留空回退到 llmModel
  llmFastModel: string;
  llmApiKey: string;
  // 可选：Tavily API key（agent 模式下 web_search / fetch_page 工具需要）。
  // 留空时工具会返回 tavily_key_not_configured 错误，agent loop 由 LLM 决定如何处理（决策 15 / D004 沿用）
  tavilyApiKey: string;
  thinkingModeEnabled: boolean;
  // 思考强度三档；llm-client 按 provider 翻译为 reasoning.effort（OpenAI/OpenRouter）
  // 或 reasoning.enabled（custom 兜底）。新装 db.json 旧数据缺此字段时按 'medium' 兜底。
  thinkingEffort: ThinkingEffort;
  // provider 路由 enum：决定请求体 reasoning 字段格式 + 是否回填历史 reasoning_details
  provider: SettingsProvider;
  privacyAcknowledged: boolean;
}

export type ThinkingEffort = 'low' | 'medium' | 'high';

// 注：暂只支持 OpenAI 兼容协议；用户用 Claude 时走 'openrouter' 分支即可。
// 'custom' 是向后兼容兜底——旧 db.json 推断不出 provider 时落到此分支
export type SettingsProvider = 'openai' | 'deepseek' | 'openrouter' | 'custom';

// SSE 事件
export type StreamEvent =
  | { type: 'reasoning'; delta: string }
  // OpenRouter / OpenAI 推理模型的结构化 reasoning_details 增量；
  // 与 'reasoning' 并行 yield（'reasoning' 给 UI 渲染，本事件给持久化以维持多轮思考连续性）
  | { type: 'reasoning_details'; delta: ReasoningDetail[] }
  | { type: 'content'; delta: string }
  | { type: 'done'; messageId: string }
  | { type: 'error'; error: string }
  // 自动标题生成成功（双轨制中的"自动"轨）：每 3 轮（6 条 message）触发一次。
  // 必须在 done 之前 yield（IPC 监听器收到 done 即 unsubscribe，trailing 事件会丢失，详见 E016）
  | { type: 'title'; nodeId: string; title: string }
  // 自动标题生成失败：把领域错误转成简化 code（empty_node / not_configured / llm_failed / unknown），
  // 前端按 code 映射 toast 文案。与 'title' 同样必须在 done 之前 yield
  | { type: 'title_error'; nodeId: string; error: string }
  // 内部事件：streamChat 在 native_tools 模式下聚合完成后 yield，
  // 仅 agent.ts 消费（conversation/refine 路径不传 tools，永远不会收到）；
  // 不会被 server.ts 转发到 SSE 响应（无传入路径触达）
  | { type: 'tool_calls'; calls: LLMToolCall[] }
  // === Agent 模式专属事件（详见 docs/agent-design.md §4.3）===
  // thought 流式：与 reasoning 同语义，但归属 agent loop 当前 step
  | { type: 'agent_thought'; stepId: string; delta: string }
  // action 一次性推送：LLM 决定调某工具的瞬间，工具尚未执行
  | {
      type: 'agent_action';
      stepId: string;
      toolCallId: string;
      toolName: ToolName;
      toolArgs: Record<string, unknown>;
    }
  // observation 一次性推送：工具执行完成（成功或失败）
  | {
      type: 'agent_observation';
      stepId: string;
      toolCallId: string;
      success: boolean;
      // 成功：result 是给 UI 看的摘要文本（"返回 8 条结果" / "完成（约 2400 字）"）
      result?: string;
      errorReason?: string;
      truncated?: boolean;
    }
  // agent loop 终结：reason 区分正常完成 vs 各种触限/中断；之后会接 content 流（Final Response）
  | { type: 'agent_final'; reason: AgentFinalReason };

// agent loop 的终止原因
export type AgentFinalReason =
  | 'completed'              // LLM 决定信息已足够，给出 Final Response
  | 'aborted_by_user'        // 用户点中断按钮
  | 'aborted_by_new_message' // 用户在 agent 跑时输入新消息（§7.1）
  | 'max_steps'              // 触达 8 步硬约束
  | 'max_time'               // 触达 3 分钟硬约束
  | 'max_same_tool'          // 同种工具调用 5 次硬约束
  | 'tool_error_fatal';      // 连续工具失败无法恢复

// LLM 客户端协议（INV-11 拆分后的语义）：
// - agentTrace 永不进入此结构（R019 协议无关守卫）
// - reasoningContent 按协议要求传递：DeepSeek-Reasoner / Anthropic Extended Thinking 等推理模型
//   要求多轮调用时携带历史 assistant 的 reasoning_content，否则 400；OpenAI o1 系列服务端管理状态
//   不需客户端回传——是否实际写入请求体由 llm-client 协议层决定
export interface LLMMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  // 仅 role='assistant' 且模型上一轮输出过 reasoning_content 时填写——回传给下一轮调用
  // （DeepSeek-Reasoner 等思考模式协议要求；不带会 400 invalid_request_error）
  reasoningContent?: string | null;
  // 仅 role='assistant'：OpenRouter 协议下回传给下一轮调用，维持跨轮思考连续性。
  // 其他 provider（openai/deepseek/custom）不写入请求体——见 toOpenAIMessage 守卫
  reasoningDetails?: ReasoningDetail[] | null;
  // 仅 role='assistant' 且本轮发起了工具调用时填写——回灌到下一轮 LLM 让模型知道自己请求过哪些工具
  toolCalls?: LLMToolCall[];
  // 仅 role='tool' 时填写——把工具结果回灌时的 OpenAI 协议关联字段
  toolCallId?: string;
}

// 一次工具调用的完整描述（OpenAI Function Calling 协议聚合后的形态）
export interface LLMToolCall {
  // OpenAI 给的 tool_call_id，用于关联 observation
  id: string;
  // 工具名（应在 ToolName 集合中；非 ToolName 时由 agent.ts 兜底为失败）
  name: string;
  // JSON string，由 agent.ts 解析为对应工具的 Args
  argumentsJson: string;
}

// === Agent / Tool 类型（详见 docs/agent-design.md）===

// 当前 MVP 仅两个工具：网络搜索、网页内容读取（均经 Tavily API 提供）
export type ToolName = 'web_search' | 'fetch_page';

// 持久化在 Message.agentTrace 中的轨迹条目，与 SSE 的 agent_* 事件一一对应
// （事件是流式即时形态，AgentStep 是落库的最终形态）
export type AgentStep =
  | { id: string; type: 'thought'; content: string; timestamp: string }
  | {
      id: string;
      type: 'action';
      toolCallId: string;
      toolName: ToolName;
      toolArgs: Record<string, unknown>;
      timestamp: string;
    }
  | {
      id: string;
      type: 'observation';
      toolCallId: string;
      success: boolean;
      // 给 UI 显示的简短摘要文本，例如 "返回 8 条结果"
      result?: string;
      errorReason?: string;
      truncated?: boolean;
      timestamp: string;
    }
  | { id: string; type: 'final'; reason: AgentFinalReason; timestamp: string };

// 工具具体参数 / 返回值类型——单独 export 给 tools/* 与 agent.ts 复用

export interface WebSearchArgs {
  query: string;
  // 1-10；默认 5
  maxResults?: number;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  results: WebSearchResultItem[];
}

export interface FetchPageArgs {
  url: string;
}

export interface FetchPageResult {
  url: string;
  title: string;
  content: string; // markdown / 纯文本，已剥离脚本与样式
  // 是否被 50_000 字符上限截断（§六硬约束）
  truncated: boolean;
}

// 工具调用模式：自适应——优先 native_tools，模型不支持则降级
export type ToolCallMode = 'native_tools' | 'react_text';

// ToolExecutionResult.error 用于工具内部优雅降级（仍继续 loop）；
// ToolExecutionError 用于 agent loop 外层 try-catch——表示无法恢复的致命错误，需终止 loop 并推 agent_final(tool_error_fatal)。
export class ToolExecutionError extends Error {
  constructor(
    public toolName: ToolName,
    public reason: string,
  ) {
    super(`tool_execution_failed: ${toolName} - ${reason}`);
    this.name = 'ToolExecutionError';
  }
}

// 错误类型
export class ContextOverflowError extends Error {
  constructor(
    public estimatedTokens: number,
    public modelLimit: number,
    public suggestion: string,
  ) {
    super(`Context overflow: ${estimatedTokens}/${modelLimit}`);
    this.name = 'ContextOverflowError';
  }
}

export class NotConfiguredError extends Error {
  constructor() {
    super('LLM not configured. Please set baseURL, model, and apiKey first.');
    this.name = 'NotConfiguredError';
  }
}

export class StreamingNodeError extends Error {
  constructor(nodeId: string) {
    super(`Node ${nodeId} is currently streaming and cannot be modified.`);
    this.name = 'StreamingNodeError';
  }
}

// 编辑/截断式删除消息时，被分支引用的消息不可改变（2c 硬阻断）：
// 若 fromSequence ≤ 任一出边 branch 的 inheritedUntilSequence，
// 截断会让子分支的继承上下文凭空消失/内容静默改变——拒绝操作。
export class MessageReferencedByBranchError extends Error {
  constructor(public childNodeIds: string[]) {
    super(`Cannot truncate: messages are referenced by ${childNodeIds.length} branch(es).`);
    this.name = 'MessageReferencedByBranchError';
  }
}

// 用户主动触发标题重新生成时的领域错误（三类细分）。
// 路由层（mock-server / ipc.ts）将它们映射为具体 HTTP 状态码与 error code，
// 前端 toast 根据 error code 给出有针对性的提示而非笼统"失败"。
//
// NodeNotFoundError：节点 id 在数据库中查不到（节点被并发删除，或 id 传错）。
// 路由层映射为 404 not_found。
export class NodeNotFoundError extends Error {
  constructor(nodeId: string) {
    super(`Node not found: ${nodeId}`);
    this.name = 'NodeNotFoundError';
  }
}

// NoMessagesForTitleError：节点存在但没有任何消息，无内容可供 LLM 概括。
// 路由层映射为 400 empty_node；这是用户操作时序问题，非 LLM 故障。
export class NoMessagesForTitleError extends Error {
  constructor() {
    super('节点尚无对话消息，无法生成标题');
    this.name = 'NoMessagesForTitleError';
  }
}

// TitleGenerationFailedError：LLM 调用返回了空内容（或被快模型清理后为空）。
// 通常说明快模型配置无效或不可达；路由层映射为 502 llm_failed。
export class TitleGenerationFailedError extends Error {
  constructor(reason: string) {
    super(`Title generation failed: ${reason}`);
    this.name = 'TitleGenerationFailedError';
  }
}
