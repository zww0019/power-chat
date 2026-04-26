// llm-client-module
// 封装 OpenAI 兼容协议客户端。real 模式调真实端点；mock 模式返回 fixture（测试用）。
//
// 关键约束（INV-11）：调用方传入的 messages 数组必须已经剥离 reasoningContent
// 字段。本模块原样转发，不做二次过滤——上下文组装的责任在 conversation-module。

import type { LLMMessage, LLMToolCall, StreamEvent } from '../types.js';
import { NotConfiguredError, ContextOverflowError } from '../types.js';
import { getSettings, isConfigured } from './settings.js';
import { chunkText } from './_utils.js';
import {
  matchResponse,
  REFINE_RESPONSE,
  detectAgentToolHint,
  AGENT_PRE_TOOL_THOUGHT,
  AGENT_FINAL_AFTER_TOOL,
  AGENT_FORCE_LOOP_SEARCH,
  AGENT_FORCE_LOOP_ALTERNATE,
  AGENT_REACT_FORCE_SEARCH,
  REACT_FIRST_ROUND_JSON,
  REACT_FINAL_JSON,
} from './fixtures.js';
import { readSSELines } from './sse.js';
import type { OpenAIToolDescriptor } from './tools/index.js';

// Token 估算（C3 决策：单一保守系数）
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let chinese = 0;
  let other = 0;
  for (const ch of text) {
    if (/[一-鿿]/.test(ch)) chinese++;
    else other++;
  }
  // 中文 ×0.7，其他 ×0.4
  return Math.ceil(chinese * 0.7 + other * 0.4);
}

export function estimateMessagesTokens(messages: LLMMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

const MODEL_LIMITS: Record<string, number> = {
  'deepseek-reasoner': 64_000,
  'deepseek-chat': 128_000,
  'gpt-4': 8_192,
  'gpt-4-turbo': 128_000,
  'gpt-4o': 128_000,
  'o1': 200_000,
};

export function getModelLimit(model: string): number {
  return MODEL_LIMITS[model] ?? 32_000; // 保守默认
}

export interface StreamChatParams {
  messages: LLMMessage[];
  enableReasoning: boolean;
  isRefineTask?: boolean; // 用于 mock 时区分调用类型
  // 调用方覆写采样参数；未传走端点默认
  temperature?: number;
  // 调用方覆写模型；未传则用 settings.llmModel
  modelOverride?: string;
  // 仅 completeChat 转发（实际不发到流式端点）
  maxTokens?: number;
  // M2a 新增：OpenAI Function Calling 协议工具描述。仅 agent.ts 在 native_tools 模式下传入；
  // conversation/refine 不传——确保它们不会收到 tool_calls 事件
  tools?: OpenAIToolDescriptor[];
  // M2a 新增：中断信号。fetch 接入后由调用方触发 abort 即可终止流
  signal?: AbortSignal;
}

// 流式调用：返回 AsyncIterable<StreamEvent>
export async function* streamChat(params: StreamChatParams): AsyncIterable<StreamEvent> {
  if (!(await isConfigured()) && process.env.USE_MOCK_LLM !== '1') {
    throw new NotConfiguredError();
  }

  const settings = await getSettings();
  const model = params.modelOverride || settings.llmModel || 'mock-model';
  const tokensIn = estimateMessagesTokens(params.messages);
  const limit = getModelLimit(model);
  if (tokensIn > limit * 0.8) {
    throw new ContextOverflowError(
      tokensIn,
      limit,
      '建议先选中相关节点做一次"提炼"，在提炼节点上继续讨论可显著降低上下文。',
    );
  }

  if (process.env.USE_MOCK_LLM === '1' || !settings.llmApiKey) {
    yield* mockStream(params);
    return;
  }

  // 真实 OpenAI 兼容协议调用
  yield* realStream(params, settings.llmBaseUrl, settings.llmApiKey, model);
}

// 一次性调用（用于标题生成等高频轻量任务）
export async function completeChat(
  messages: LLMMessage[],
  opts?: { maxTokens?: number; temperature?: number; modelOverride?: string },
): Promise<string> {
  if (!(await isConfigured()) && process.env.USE_MOCK_LLM !== '1') {
    return ''; // 静默失败：标题生成允许失败
  }
  const maxTokens = opts?.maxTokens ?? 32;
  let result = '';
  try {
    for await (const evt of streamChat({
      messages,
      enableReasoning: false,
      temperature: opts?.temperature,
      modelOverride: opts?.modelOverride,
    })) {
      if (evt.type === 'content') result += evt.delta;
      if (evt.type === 'done') break;
      if (evt.type === 'error') return '';
      if (result.length > maxTokens * 4) break; // 粗略提前停止
    }
  } catch {
    return '';
  }
  return result.slice(0, 30);
}

// === mock 实现 ===
// mock 路由表：根据请求形态选择不同的回放策略，避免单函数串联多个判断分支
type MockRoute =
  | { kind: 'force_loop'; tool: 'web_search' | 'fetch_page' }
  | { kind: 'after_tool' }
  | { kind: 'first_tool'; tool: 'web_search' | 'fetch_page' }
  // react_text 模式：mock 直接输出 JSON 字符串（不走 OpenAI Function Calling 协议），
  // 模拟推理模型在 native_tools 不可用时的文本协议路径
  | { kind: 'react_text'; phase: 'first' | 'final' }
  | { kind: 'default' };

// mock 路由：测试触发词优先（react_text / force_loop_*），其次 after_tool，再次工具关键词探测，否则默认。
// 用 const arrow function 而非 function 声明，是为让 lizard 不把它与紧邻的 generator function* mockStream
// 错误粘连成一体（lizard 在 TS generator + return 类型混合时的解析 bug 会误报 PARAM/CCN 偏高）。
const pickMockRoute = (
  userText: string,
  hasTools: boolean,
  toolMessageCount: number,
): MockRoute => {
  // react_text 触发词不要求 hasTools——agent.ts 在 react_text 模式下传 tools=undefined
  if (userText.includes(AGENT_REACT_FORCE_SEARCH)) {
    return { kind: 'react_text', phase: toolMessageCount > 0 ? 'final' : 'first' };
  }
  if (hasTools && userText.includes(AGENT_FORCE_LOOP_SEARCH)) {
    return { kind: 'force_loop', tool: 'web_search' };
  }
  if (hasTools && userText.includes(AGENT_FORCE_LOOP_ALTERNATE)) {
    const tool = toolMessageCount % 2 === 0 ? 'web_search' : 'fetch_page';
    return { kind: 'force_loop', tool };
  }
  if (toolMessageCount > 0) return { kind: 'after_tool' };
  if (hasTools) {
    const hint = detectAgentToolHint(userText);
    if (hint) return { kind: 'first_tool', tool: hint };
  }
  return { kind: 'default' };
};

async function* mockStream(params: StreamChatParams): AsyncIterable<StreamEvent> {
  const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
  const userText = lastUser?.content ?? '';
  const toolMessageCount = params.messages.filter((m) => m.role === 'tool').length;
  const hasTools = !!(params.tools && params.tools.length > 0);

  const route = pickMockRoute(userText, hasTools, toolMessageCount);
  if (route.kind === 'force_loop' || route.kind === 'first_tool') {
    yield* mockToolCallStream(route.tool, userText);
    return;
  }
  if (route.kind === 'after_tool') {
    yield* mockFinalResponseStream(AGENT_FINAL_AFTER_TOOL);
    return;
  }
  if (route.kind === 'react_text') {
    const json = route.phase === 'first' ? REACT_FIRST_ROUND_JSON : REACT_FINAL_JSON;
    yield* mockJsonContentStream(json);
    return;
  }
  yield* mockDefaultFixtureStream(params, userText);
}

// 流式回放 JSON 字符串（按 content delta 模拟 LLM 输出整段 JSON）
// agent.ts 的 react_text 路径会把整段累积后 parseReactJson 解析
async function* mockJsonContentStream(jsonText: string): AsyncIterable<StreamEvent> {
  for (const chunk of chunkText(jsonText, 8)) {
    yield { type: 'content', delta: chunk };
    await sleep(10);
  }
  yield { type: 'done', messageId: `m_${Date.now().toString(36)}` };
}

// 默认路径：fixture 匹配 → reasoning（可选）+ content 流式 + done
async function* mockDefaultFixtureStream(
  params: StreamChatParams,
  userText: string,
): AsyncIterable<StreamEvent> {
  const cannedResponse = params.isRefineTask ? REFINE_RESPONSE : matchResponse(userText);

  if (params.enableReasoning && cannedResponse.reasoning) {
    for (const chunk of chunkText(cannedResponse.reasoning, 8)) {
      yield { type: 'reasoning', delta: chunk };
      await sleep(30);
    }
    await sleep(150);
  }

  for (const chunk of chunkText(cannedResponse.content, 6)) {
    yield { type: 'content', delta: chunk };
    await sleep(35);
  }

  yield { type: 'done', messageId: `m_${Date.now().toString(36)}` };
}

// 模拟"先 yield 短 content（thought 性质）→ 再 yield tool_calls → done"的协议形态
async function* mockToolCallStream(hint: 'web_search' | 'fetch_page', userText: string): AsyncIterable<StreamEvent> {
  for (const chunk of chunkText(AGENT_PRE_TOOL_THOUGHT[hint], 6)) {
    yield { type: 'content', delta: chunk };
    await sleep(15);
  }
  // 构造一个伪 LLMToolCall，参数从 user message 中提取（web_search 用 user 全文为 query；fetch_page 抽 URL）
  const args = hint === 'fetch_page'
    ? { url: userText.match(/https?:\/\/\S+/)?.[0] ?? 'https://example.com' }
    : { query: userText, maxResults: 3 };
  yield {
    type: 'tool_calls',
    calls: [
      {
        id: `mock_call_${Date.now().toString(36)}`,
        name: hint,
        argumentsJson: JSON.stringify(args),
      },
    ],
  };
  yield { type: 'done', messageId: `m_${Date.now().toString(36)}` };
}

// 流式回放固定 Final Response 文本，用于 agent 二次调用
async function* mockFinalResponseStream(text: string): AsyncIterable<StreamEvent> {
  for (const chunk of chunkText(text, 8)) {
    yield { type: 'content', delta: chunk };
    await sleep(15);
  }
  yield { type: 'done', messageId: `m_${Date.now().toString(36)}` };
}

// === real 实现（OpenAI 兼容协议）===
async function* realStream(
  params: StreamChatParams,
  baseUrl: string,
  apiKey: string,
  model: string,
): AsyncIterable<StreamEvent> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = buildOpenAIRequestBody(params, model);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: params.signal,
    });
  } catch (e) {
    yield { type: 'error', error: classifyFetchError(e, params.signal) };
    return;
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    yield { type: 'error', error: `[${res.status}] ${text.slice(0, 200)}` };
    return;
  }

  yield* consumeOpenAIStream(res.body, params.signal);
}

// 拼装 OpenAI Chat Completion 请求体。抽出避免与流读取/错误处理的控制流混在 realStream 顶层
function buildOpenAIRequestBody(params: StreamChatParams, model: string): Record<string, unknown> {
  return {
    model,
    // OpenAI 协议字段名是 snake_case；仓库内部用 camelCase——这里做一次转换
    messages: params.messages.map(toOpenAIMessage),
    stream: true,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
    ...(params.enableReasoning ? { reasoning: { enabled: true } } : {}),
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
  };
}

// AbortError 与普通错误的双重识别（DOMException name + signal.aborted），让调用方区分用户中断与基础设施失败
function classifyFetchError(e: unknown, signal: AbortSignal | undefined): string {
  const err = e as { name?: string; message?: string } | undefined;
  if (err?.name === 'AbortError' || signal?.aborted) return 'aborted';
  return `network_error: ${err?.message ?? e}`;
}

function classifyStreamError(e: unknown, signal: AbortSignal | undefined): string {
  const err = e as { name?: string; message?: string } | undefined;
  if (err?.name === 'AbortError' || signal?.aborted) return 'aborted';
  return `stream_error: ${err?.message ?? e}`;
}

// 流式读取 SSE 主循环：把"accumulate tool_calls + 透传 events" 与 realStream 顶层 fetch 错误处理解耦
async function* consumeOpenAIStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncIterable<StreamEvent> {
  let messageId = `m_${Date.now().toString(36)}`;
  // tool_calls 协议是 chunked：function.name 与 arguments 跨多个 SSE 帧增量；
  // 按 index 累积到流结束才有完整调用形态
  const toolCallsBuf = new Map<number, ToolCallAggBuf>();
  try {
    for await (const line of readSSELines(body)) {
      const parsed = parseSSELine(line, messageId);
      messageId = parsed.newMsgId;
      for (const evt of parsed.events) yield evt;
      aggregateToolCallChunks(toolCallsBuf, parsed.toolCallChunks);
    }
  } catch (e) {
    yield { type: 'error', error: classifyStreamError(e, signal) };
    return;
  }
  // 聚合 tool_calls 在 done 之前 yield；agent.ts 由此识别"本轮 LLM 决定调工具"
  const calls = flushAggregatedToolCalls(toolCallsBuf);
  if (calls.length > 0) yield { type: 'tool_calls', calls };
  yield { type: 'done', messageId };
}

interface ToolCallAggBuf {
  id?: string;
  name?: string;
  argsJson: string;
}

function aggregateToolCallChunks(buf: Map<number, ToolCallAggBuf>, chunks: ToolCallChunk[]): void {
  for (const tc of chunks) {
    const cur = buf.get(tc.index) ?? { argsJson: '' };
    if (tc.id) cur.id = tc.id;
    if (tc.name) cur.name = tc.name;
    if (tc.argumentsDelta) cur.argsJson += tc.argumentsDelta;
    buf.set(tc.index, cur);
  }
}

// 把按 index 累积的 chunk buffer 转成完整的 LLMToolCall[]；协议异常时丢弃不完整项，避免下游 NPE
function flushAggregatedToolCalls(buf: Map<number, ToolCallAggBuf>): LLMToolCall[] {
  return Array.from(buf.values())
    .filter((c) => c.id && c.name)
    .map((c) => ({ id: c.id!, name: c.name!, argumentsJson: c.argsJson }));
}

// 把仓库内部 LLMMessage（camelCase）转为 OpenAI Chat Completion API 期望的 snake_case 形态
function toOpenAIMessage(m: LLMMessage): Record<string, unknown> {
  const msg: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.toolCalls && m.toolCalls.length > 0) {
    msg.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.argumentsJson },
    }));
  }
  if (m.toolCallId) msg.tool_call_id = m.toolCallId;
  return msg;
}

// 单 chunk 内一条 tool_call delta 的拆分：按 index 让 realStream 累积成完整调用
interface ToolCallChunk {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

// 单行 SSE 解析：识别 OpenAI 兼容协议的 `data: { ... }` 帧。
// 返回普通文本 events + tool_call delta chunks（分两路是因为后者需跨行累积，前者是即时增量）。
function parseSSELine(line: string, currentMsgId: string): {
  events: StreamEvent[];
  toolCallChunks: ToolCallChunk[];
  newMsgId: string;
} {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data: ')) return { events: [], toolCallChunks: [], newMsgId: currentMsgId };
  const json = trimmed.slice(6);
  if (json === '[DONE]') return { events: [], toolCallChunks: [], newMsgId: currentMsgId };
  try {
    const chunk = JSON.parse(json);
    const delta = chunk.choices?.[0]?.delta;
    const newMsgId = chunk.id ?? currentMsgId;
    if (!delta) return { events: [], toolCallChunks: [], newMsgId };
    const events: StreamEvent[] = [];
    const toolCallChunks: ToolCallChunk[] = [];
    if (delta.reasoning_content) events.push({ type: 'reasoning', delta: delta.reasoning_content });
    if (delta.content) events.push({ type: 'content', delta: delta.content });
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        toolCallChunks.push({
          index: tc.index ?? 0,
          id: tc.id,
          name: tc.function?.name,
          argumentsDelta: tc.function?.arguments,
        });
      }
    }
    return { events, toolCallChunks, newMsgId };
  } catch {
    return { events: [], toolCallChunks: [], newMsgId: currentMsgId };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
