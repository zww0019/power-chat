// agent-module
// ReAct loop orchestration：thought → action → observation 循环，直到 LLM 给出 Final Response。
//
// 与 conversation-module 的关系：
// - conversation.sendMessage 始终把 LLM 调用交给 runAgentLoop（决策 6：纯 LLM 判断）
// - 如果 LLM 决定不调工具，runAgentLoop 退化为单轮普通对话——保持现有行为
// - 如果 LLM 调工具，runAgentLoop 进入 ReAct 循环并通过 agent_* 事件上报过程
//
// 协议自适应（决策 D013 / D018）：
// - native_tools：调 streamChat 带 tools；从 'tool_calls' 内部事件识别工具调用
// - react_text：不传 tools；要求 LLM 输出严格 JSON；解析后驱动相同工具执行流程
//
// 硬约束（产品层强制，§六 / R018）：
// - max steps = 8
// - max time = 3 分钟
// - max same-tool calls = 5
// - max page chars = 50_000（在 fetch_page 内部截断）
// - global concurrent agents = 1（M5 实施）
// 这些都在本模块 enforce，不暴露给 LLM（仅 prompt 软约束让 LLM 配合）。

import type {
  LLMMessage,
  LLMToolCall,
  ReasoningDetail,
  SettingsProvider,
  StreamEvent,
  ThinkingEffort,
  ToolCallMode,
  ToolName,
  AgentStep,
  AgentFinalReason,
} from '../types.js';
import { getSettings } from './settings.js';
import { streamChat } from './llm-client.js';
import { ALL_TOOLS, getToolsAsOpenAIFormat } from './tools/index.js';
import { newId, nowIso, chunkText, mergeReasoningDeltas } from './_utils.js';

export interface RunAgentLoopParams {
  // 已组装好的完整 messages（含调用方负责的 system prompt + 对话历史 + 当前 user message）。
  // runAgentLoop 在循环内会动态追加 assistant tool_calls 与 tool result 消息
  initialMessages: LLMMessage[];
  enableReasoning: boolean;
  // 思考强度与 provider 透传给 streamChat；未传由 streamChat 从 settings 兜底
  thinkingEffort?: ThinkingEffort;
  provider?: SettingsProvider;
  temperature?: number;
  signal?: AbortSignal;
}

// agent loop 的硬约束（数值常量集中在此，便于 M5 调优 / 测试覆盖）
export const AGENT_HARD_LIMITS = {
  maxSteps: 8,
  maxDurationMs: 3 * 60 * 1000,
  maxSameToolCalls: 5,
} as const;

// === Agent 系统提示（追加在调用方风格 prompt 之后）===
// 文档 §五原则：约束 LLM 默认不调工具；仅在用户明确动作动词请求时使用。
// react_text 模式下追加 JSON 输出格式说明。
export const AGENT_SYSTEM_PROMPT_NATIVE = `你有一组工具可以使用，工具描述见 tools 字段。

工具使用原则：

只在用户明确表达"查一下""搜一下""帮我找""读一下这个网页"等需要外部信息的请求时才调用工具。
对一般性的对话和讨论，直接基于你的知识回应——不要每次都去搜。
对探索性、开放性的话题（"我想了解 X""这个最近怎么样"），先用对话澄清用户具体想知道什么，不要立刻启动工具。

如果决定使用工具，让你的过程对用户透明：
- 在调用工具前，先简短说一句你打算做什么、为什么
- 工具结果出来后，简短说一句你看到了什么、下一步打算怎么办
- 不要静默地连续调用工具——每一步都让用户能跟上

如果一次任务需要超过 5 步工具调用，先停下来给用户阶段性回复，问他要不要继续深挖。

工具失败时不要假装成功。明确告诉用户哪个工具调用失败了、可能的原因。`;

// react_text 模式下额外追加：要求 LLM 用严格 JSON 输出
export const AGENT_SYSTEM_PROMPT_REACT_FORMAT = `由于当前模型不支持原生工具调用协议，请用以下严格 JSON 格式输出：

调用工具时：
{"thought":"我打算做的事...","action":{"tool":"web_search","args":{"query":"..."}}}

最终回复时：
{"thought":"我已经收集到足够信息...","final":"给用户的完整回复..."}

注意：
- 输出必须是单一 JSON 对象，不要附加任何其他文字
- thought 字段必填，让用户看到你的推理过程
- action 与 final 字段二选一，不能同时出现
- 工具描述如下：

`;

// 把工具协议描述拼成 react_text 模式 system prompt 用的文本块
function getToolsAsTextDescriptor(): string {
  const tools = getToolsAsOpenAIFormat();
  return tools
    .map((t) => `### ${t.function.name}\n${t.function.description}\n参数: ${JSON.stringify(t.function.parameters)}`)
    .join('\n\n');
}

/**
 * agent loop 的入口。流式输出 agent_* 事件和最终的 content/done 事件——
 * 调用方零 if-else 处理两种模式。
 *
 * 行为：
 * - 第一轮 LLM 若不返回 tool_calls，退化为单轮普通对话（reasoning + content + done）
 * - 第一轮返回 tool_calls 则进入循环：执行工具 → 回灌 observation → 再调 LLM
 * - 触达硬约束（max_steps / max_same_tool）后调一次 summarize（不带 tools）给 Final Response
 */
export async function* runAgentLoop(params: RunAgentLoopParams): AsyncIterable<StreamEvent> {
  const mode = await detectToolSupport();
  const messages = enrichSystemPromptWithAgentBlock(params.initialMessages, mode);

  let stepCount = 0;
  const sameToolCounter = new Map<string, number>();
  const startedAt = Date.now();

  while (stepCount < AGENT_HARD_LIMITS.maxSteps) {
    if (Date.now() - startedAt > AGENT_HARD_LIMITS.maxDurationMs) {
      yield* finalizeWithSummary(messages, params, 'max_time');
      return;
    }
    if (params.signal?.aborted) {
      yield { type: 'agent_final', reason: 'aborted_by_user' };
      yield { type: 'done', messageId: newId('m') };
      return;
    }

    const round = newOneRoundResult();
    // 流式透传：边消费 LLM 流边 yield content/reasoning 事件，
    // 不再等整轮跑完才一次性输出（避免前端"长时间等待→突然全部出现"的伪流式表现）
    yield* runOneLLMRoundStream(messages, params, mode, round);

    // 错误事件：abort 路径转换为 agent_final（aborted_by_user）让消息优雅完成；
    // 真错误（network / stream / context overflow）才透传
    if (round.errorEvent) {
      if (round.errorEvent.type === 'error' && round.errorEvent.error === 'aborted') {
        yield { type: 'agent_final', reason: 'aborted_by_user' };
        yield { type: 'done', messageId: round.messageId };
        return;
      }
      yield round.errorEvent;
      return;
    }

    if (round.toolCalls.length === 0) {
      // 无工具调用：本轮 content 即 Final Response（或单轮普通对话）
      yield { type: 'done', messageId: round.messageId };
      return;
    }

    // 有工具调用：进入 step（记入 trace + 执行 + 回灌）
    stepCount++;
    messages.push({
      role: 'assistant',
      content: round.contentBuf, // 工具调用前的 thought 性质内容
      // 段内 sub-turn 必须携带 reasoning_content（R020b / E014）——
      // DeepSeek-Reasoner native_tools 协议要求，不带会 400 invalid_request_error。
      // `|| null` 而非直接 reasoningBuf：toOpenAIMessage 用 `if(m.reasoningContent)` falsy 守卫
      // 跳过空字符串；若改为 undefined 则 JSON 序列化会漏掉字段，null 可显式占位
      reasoningContent: round.reasoningBuf || null,
      // OpenRouter 协议下保持思考连续性：段内 assistant 携带本轮收到的 reasoning_details 数组，
      // toOpenAIMessage 仅在 provider=openrouter 时回填到请求体（其他 provider 忽略）
      reasoningDetails: round.reasoningDetailsBuf.length > 0 ? round.reasoningDetailsBuf : null,
      toolCalls: round.toolCalls,
    });

    for (const call of round.toolCalls) {
      const overflowed = bumpSameToolCounter(sameToolCounter, call.name);
      if (overflowed) {
        yield* finalizeWithSummary(messages, params, 'max_same_tool');
        return;
      }
      yield* executeAndYieldStep(call, messages, params.signal);
    }
  }

  // 自然循环退出：达到 max_steps
  yield* finalizeWithSummary(messages, params, 'max_steps');
}

// ============== 单轮 LLM 调用 ==============

interface OneRoundResult {
  // 本轮 content 累积（用于写入 assistant message）
  contentBuf: string;
  // 本轮 reasoning 累积（用于段内回灌 assistant message 的 reasoning_content 字段）：
  // DeepSeek-Reasoner 思考模式协议要求——段内（同一 turn 多 sub-turn 之间）assistant 历史的
  // reasoning_content **必须**回传给后续调用，不传则 400 invalid_request_error。
  // 详见 R020b / E014。仅 native_tools 模式 + enableReasoning=true 路径有内容
  reasoningBuf: string;
  // 本轮 OpenRouter / OpenAI 推理模型回传的结构化 reasoning_details 累积。
  // 段内 sub-turn 必须按原结构原样回传给 OpenRouter，否则在工具调用期间会丢思考连续性
  reasoningDetailsBuf: ReasoningDetail[];
  // 本轮捕获的工具调用（多轮模式：本轮 LLM 决定调哪些工具）
  toolCalls: LLMToolCall[];
  // 本轮 LLM 的 messageId（用于 done 事件）
  messageId: string;
  // 流式过程中的错误（中断 / 网络），有则直接抛上层
  errorEvent: StreamEvent | null;
}

function newOneRoundResult(): OneRoundResult {
  return {
    contentBuf: '',
    reasoningBuf: '',
    reasoningDetailsBuf: [],
    toolCalls: [],
    messageId: newId('m'),
    errorEvent: null,
  };
}

// 单轮 LLM 流式消费：边消费 SSE 边 yield reasoning/content delta，
// 同时把 toolCalls / messageId / errorEvent / 累积 buffer 写到 result（out param）。
//
// 改造前是"全部消费完返回 OneRoundResult，passthroughEvents 数组带回上游一次性 yield"——
// 这种攒批模式下前端会感知不到流式（长时间等待 → 末尾全部出现）。改为 async generator 后
// 每个 LLM delta 都立即穿透到 _utils.runAgentAssistantStream，再到 IPC，再到前端。
async function* runOneLLMRoundStream(
  messages: LLMMessage[],
  params: RunAgentLoopParams,
  mode: ToolCallMode,
  result: OneRoundResult,
): AsyncIterable<StreamEvent> {
  const tools = mode === 'native_tools' ? getToolsAsOpenAIFormat() : undefined;
  const llmStream = streamChat({
    messages,
    enableReasoning: params.enableReasoning,
    thinkingEffort: params.thinkingEffort,
    provider: params.provider,
    tools,
    temperature: params.temperature ?? 0.7,
    signal: params.signal,
  });

  // react_text 模式下 LLM 以大量细粒度 delta 输出整段 JSON；
  // 用数组收集再 join 避免 O(n²) 的字符串拼接（LLM 输出 token 数越多收益越明显）
  const reactChunks: string[] = [];
  for await (const evt of llmStream) {
    if (evt.type === 'reasoning') {
      // 累积到 reasoningBuf：段内 sub-turn 的 assistant message 必须携带完整 reasoning_content
      // 才能满足 DeepSeek-Reasoner 协议（R020b）；同时 yield 给前端实时显示
      result.reasoningBuf += evt.delta;
      yield evt;
      continue;
    }
    if (evt.type === 'reasoning_details') {
      // OpenRouter 结构化思考片段——段内回灌时必须保持原始结构与顺序，
      // 不能拍平为字符串；调用方拿到 reasoningDetailsBuf 写到 LLMMessage.reasoningDetails。
      // 按 index 合并而非 spread 追加：同一 thinking block 的 type/text/signature 可能分散
      // 在多帧 delta 中，spread 会把它们拆成多个独立元素，导致 Bedrock 校验 signature 失败
      result.reasoningDetailsBuf = mergeReasoningDeltas(result.reasoningDetailsBuf, evt.delta);
      yield evt;
      continue;
    }
    if (evt.type === 'content') {
      if (mode === 'native_tools') {
        result.contentBuf += evt.delta;
        yield evt;
      } else {
        // react_text：累积不透传——整段 JSON 不应展示给用户
        reactChunks.push(evt.delta);
      }
      continue;
    }
    if (evt.type === 'tool_calls') {
      result.toolCalls = evt.calls;
      continue;
    }
    if (evt.type === 'done') {
      result.messageId = evt.messageId;
      continue;
    }
    if (evt.type === 'error') {
      result.errorEvent = evt;
      return;
    }
  }
  // react_text 模式后处理：流结束后整段解析并 yield 模拟流式回放
  if (mode === 'react_text' && reactChunks.length > 0) {
    yield* streamReactTextParseResult(reactChunks.join(''), result);
  }
}

// react_text 模式：从 LLM 整段文本输出解析 JSON，转换为 toolCalls 或流式回放 final 文本。
// content delta 在 runOneLLMRoundStream 中被攒批而非实时 yield，原因：react_text 协议
// 要求 LLM 输出完整 JSON 对象后才能区分"调工具"与"最终回复"——提前 yield 原始 JSON
// 骨架会把{"thought":...,"action":...} 这类结构字符串暴露给前端。
async function* streamReactTextParseResult(
  reactRawText: string,
  result: OneRoundResult,
): AsyncIterable<StreamEvent> {
  const parsed = parseReactJson(reactRawText);
  if (parsed?.action) {
    result.toolCalls = [
      {
        id: newId('tcall'),
        name: parsed.action.tool,
        argumentsJson: JSON.stringify(parsed.action.args ?? {}),
      },
    ];
    result.contentBuf = parsed.thought ?? '';
    return;
  }
  // 没有调工具（含解析失败兜底）：把 final 字符串或原文拆 chunk 流式回放，让前端体验一致
  const finalText = parsed?.final ?? reactRawText;
  result.contentBuf = finalText;
  for (const chunk of chunkText(finalText, 12)) {
    yield { type: 'content', delta: chunk };
  }
}

// ============== 工具执行 + step yield ==============

async function* executeAndYieldStep(
  call: LLMToolCall,
  messages: LLMMessage[],
  signal: AbortSignal | undefined,
): AsyncIterable<StreamEvent> {
  const stepId = newId('step');
  const args = safeParseToolArgs(call.argumentsJson);
  const toolName = call.name as ToolName;

  // 1. yield action 事件 + 记入 trace（trace 在 _utils.runAgentAssistantStream 内累积）
  yield {
    type: 'agent_action',
    stepId,
    toolCallId: call.id,
    toolName,
    toolArgs: args,
  };

  // 2. 执行工具
  const tool = ALL_TOOLS[toolName];
  let success = false;
  let resultSummary: string | undefined;
  let errorReason: string | undefined;
  let truncated: boolean | undefined;
  let toolMessageContent: string;

  if (!tool) {
    errorReason = `unknown_tool: ${call.name}`;
    toolMessageContent = JSON.stringify({ error: errorReason });
  } else {
    const exec = await tool.execute(args, signal);
    if (exec.success) {
      success = true;
      resultSummary = summarizeToolResult(toolName, exec.data);
      truncated = (exec.data as { truncated?: boolean })?.truncated;
      toolMessageContent = JSON.stringify(exec.data);
    } else {
      errorReason = exec.error ?? 'unknown_error';
      toolMessageContent = JSON.stringify({ error: errorReason });
    }
  }

  // 3. yield observation 事件（复用同一 stepId，让 action/observation 可按 stepId 配对）
  yield {
    type: 'agent_observation',
    stepId,
    toolCallId: call.id,
    success,
    result: resultSummary,
    errorReason,
    truncated,
  };

  // 4. 把 tool result 回灌到 messages
  messages.push({
    role: 'tool',
    content: toolMessageContent,
    toolCallId: call.id,
  });
}

// 把工具返回数据压缩成给 UI 的简短摘要文本（"返回 N 条结果" / "完成（约 X 字）"）
function summarizeToolResult(name: ToolName, data: unknown): string {
  if (name === 'web_search') {
    const r = data as { results?: unknown[] };
    return `返回 ${r?.results?.length ?? 0} 条结果`;
  }
  if (name === 'fetch_page') {
    const r = data as { content?: string; truncated?: boolean };
    const len = r?.content?.length ?? 0;
    return `完成（约 ${len} 字${r?.truncated ? '，已截断' : ''}）`;
  }
  return '已完成';
}

function safeParseToolArgs(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function bumpSameToolCounter(counter: Map<string, number>, toolName: string): boolean {
  const next = (counter.get(toolName) ?? 0) + 1;
  counter.set(toolName, next);
  return next > AGENT_HARD_LIMITS.maxSameToolCalls;
}

// ============== 触限后总结调用 ==============

async function* finalizeWithSummary(
  messages: LLMMessage[],
  params: RunAgentLoopParams,
  reason: AgentFinalReason,
): AsyncIterable<StreamEvent> {
  yield { type: 'agent_final', reason };
  // 不带 tools 调一次 LLM；让它基于已有 observations 给出 Final Response。
  // 决策 9：触限不应让用户看到"超限了"的卡顿——给一个有意义的总结回复。
  let messageId = newId('m');
  for await (const evt of streamChat({
    messages,
    enableReasoning: false,
    provider: params.provider,
    temperature: 0.5,
    signal: params.signal,
  })) {
    if (evt.type === 'tool_calls') continue; // 防御：理论 summary 调用无 tools 不应收到
    if (evt.type === 'done') {
      messageId = evt.messageId;
      yield { type: 'done', messageId };
      return;
    }
    yield evt;
  }
  // 理论上 streamChat 总会 yield done；防御性兜底
  yield { type: 'done', messageId };
}

// ============== react_text JSON 解析 ==============

interface ReactJson {
  thought?: string;
  action?: { tool: string; args?: Record<string, unknown> };
  final?: string;
}

// 提取首个 {...} 块再 JSON.parse；容忍 LLM 在 JSON 前后附加非 JSON 文本
function parseReactJson(raw: string): ReactJson | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1));
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as ReactJson;
  } catch {
    return null;
  }
}

// ============== system prompt 拼装 ==============

// 把 messages[0] 的 system prompt 追加 agent block。如果 messages[0] 不是 system，前置一个空 base。
function enrichSystemPromptWithAgentBlock(messages: LLMMessage[], mode: ToolCallMode): LLMMessage[] {
  const agentBlock = mode === 'native_tools'
    ? AGENT_SYSTEM_PROMPT_NATIVE
    : `${AGENT_SYSTEM_PROMPT_NATIVE}\n\n${AGENT_SYSTEM_PROMPT_REACT_FORMAT}${getToolsAsTextDescriptor()}`;

  if (messages.length > 0 && messages[0]!.role === 'system') {
    const head: LLMMessage = {
      role: 'system',
      content: `${messages[0]!.content}\n\n${agentBlock}`,
    };
    return [head, ...messages.slice(1)];
  }
  return [{ role: 'system', content: agentBlock }, ...messages];
}

// ============== detectToolSupport（从 M2a 保留）==============

// 模型对 OpenAI Function Calling 的支持情况由模型族决定，运行期不会变化；
// 进程内缓存即可，不持久化（错误结果有可能因接入方升级修复，不应永久固化）
const toolSupportCache = new Map<string, ToolCallMode>();

const NATIVE_TOOLS_PREFIXES = [
  'gpt-4',
  'gpt-3.5-turbo',
  'claude-',
  'deepseek-chat',
  'deepseek-v',
  'qwen',
  'mistral-',
  'gemini-',
  'glm-4',
  'moonshot-',
];

const REACT_TEXT_PREFIXES = [
  'deepseek-reasoner',
  'deepseek-r1',
  'o1-',
  'o1',
  'r1-',
];

/**
 * 探测当前 settings.llmModel 对 OpenAI Function Calling 的支持。
 * 详见 D018：黑名单优先 + 默认乐观 + 进程内缓存。
 */
export async function detectToolSupport(): Promise<ToolCallMode> {
  const settings = await getSettings();
  const model = (settings.llmModel || '').toLowerCase();
  if (!model) return 'native_tools';
  const cached = toolSupportCache.get(model);
  if (cached) return cached;

  let mode: ToolCallMode = 'native_tools';
  if (REACT_TEXT_PREFIXES.some((p) => model.startsWith(p))) {
    mode = 'react_text';
  } else if (NATIVE_TOOLS_PREFIXES.some((p) => model.startsWith(p))) {
    mode = 'native_tools';
  }

  toolSupportCache.set(model, mode);
  return mode;
}

export function __resetToolSupportCacheForTest(): void {
  toolSupportCache.clear();
}

// 仅用于在 _utils.runAgentAssistantStream 中重建 trace 条目；这里的 newId 与 nowIso 通过 _utils 暴露，
// 但 step id 在 agent.ts 已经在 yield 事件时赋值，所以本类型仅作类型契约：
export type { AgentStep, AgentFinalReason };
