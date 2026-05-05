// llm-client-module
// 封装 OpenAI 兼容协议客户端。real 模式调真实端点；mock 模式返回 fixture（测试用）。
//
// 关键约束（INV-11 修正后语义）：
// - agentTrace：conversation-module 负责过滤，本模块不会收到此字段（R019 永不回传）
// - reasoningContent：conversation-module 按协议透传，本模块 toOpenAIMessage 写入
//   snake_case 的 reasoning_content 字段（DeepSeek-Reasoner 多轮要求，不带会 400）

import type {
  LLMMessage,
  LLMToolCall,
  ReasoningDetail,
  SettingsProvider,
  StreamEvent,
  ThinkingEffort,
} from '../types.js';
import { NotConfiguredError } from '../types.js';
import { getSettings, isConfigured } from './settings.js';
import { chunkText } from './_utils.js';
import {
  matchResponse,
  REFINE_RESPONSE,
  WRITE_RESPONSE,
  detectAgentToolHint,
  AGENT_PRE_TOOL_THOUGHT,
  AGENT_FINAL_AFTER_TOOL,
  AGENT_FORCE_LOOP_SEARCH,
  AGENT_FORCE_LOOP_ALTERNATE,
  AGENT_REACT_FORCE_SEARCH,
  REACT_FIRST_ROUND_JSON,
  REACT_FINAL_JSON,
  recordMockLLMMessages,
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
  // 包含 reasoningContent：reasoner 模型的思考内容会作为 reasoning_content 字段回传到下一轮，
  // 不计入会让 ContextOverflowError 80% 阈值守卫漏判（reasoning 通常远长于 content）
  return messages.reduce(
    (sum, m) => sum + estimateTokens(m.content) + estimateTokens(m.reasoningContent ?? '') + 4,
    0,
  );
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
  // 思考强度三档；调用方未传时由 buildOpenAIRequestBody 从 settings 兜底取 'medium'。
  // 仅当 enableReasoning=true 时生效
  thinkingEffort?: ThinkingEffort;
  // provider 路由：决定 reasoning 字段格式（effort vs enabled）以及历史 reasoning_details 是否回填
  provider?: SettingsProvider;
  isRefineTask?: boolean; // 用于 mock 时区分调用类型
  isWriteTask?: boolean; // 用于 mock 时区分调用类型（撰写任务）
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
//
// D021 决策（M5+）：撤销前置 token 守卫——`MODEL_LIMITS` 维护成本高（白名单覆盖不全
// 且各家 API 真实上限可能差异）；改为信任真实 LLM API 的拒绝行为。
// `estimateTokens` / `estimateMessagesTokens` / `MODEL_LIMITS` / `ContextOverflowError`
// 类仍保留供未来 UI 展示 token 用量或重新激活守卫使用。
//
// TODO(refactor): 本函数承担"配置守卫 + 兜底取值 + mock/real 路由 + 诊断日志"四件事，
// CCN=18 超阈值（lizard 阈值 15）。重构方向：拆 resolveStreamSettings(params)+selectStream(useMock)
// 两个小函数。范围超出本次 OpenRouter 改造，留给后续单独任务
export async function* streamChat(params: StreamChatParams): AsyncIterable<StreamEvent> {
  if (!(await isConfigured()) && process.env.USE_MOCK_LLM !== '1') {
    throw new NotConfiguredError();
  }

  const settings = await getSettings();
  const model = params.modelOverride || settings.llmModel || 'mock-model';
  // 调用方未显式指定时，从 settings 兜底——保持"调用方可覆写、未覆写按用户配置"的语义
  const provider: SettingsProvider = params.provider ?? settings.provider ?? 'custom';
  const effort: ThinkingEffort = params.thinkingEffort ?? settings.thinkingEffort ?? 'medium';
  // USE_MOCK_LLM=1 强制 mock（测试/CI）；apiKey 为空时也走 mock（未配置场景），两者都满足才是真实请求
  const useMock = process.env.USE_MOCK_LLM === '1' || !settings.llmApiKey;

  // 开发期诊断日志：Electron 主进程 / mock-server 进程的 stdout 直达终端，
  // 让用户能秒判"是否真的调了真实 API + 用的哪个模型 + 附了多少历史"。
  // 打包后的 Electron 主进程 console 默认丢弃，对生产无副作用。
  // 注意：firstUserMsgPreview 包含用户 prompt 头 30 字，仅输出到本地终端，不入文件、不上传。
  const firstUserMsgPreview = params.messages.find((m) => m.role === 'user')?.content?.slice(0, 30) ?? '';
  console.log(
    `[llm] mode=${useMock ? 'mock' : 'real'} model=${model}`,
    `temperature=${params.temperature ?? 'default'}`,
    `maxTokens=${params.maxTokens ?? 'default'}`,
    `messages=${params.messages.length}`,
    `tools=${params.tools?.length ?? 0}`,
    `firstUserMsg="${firstUserMsgPreview}"`,
  );

  if (useMock) {
    yield* mockStream(params);
    return;
  }

  // 真实 OpenAI 兼容协议调用
  yield* realStream(params, settings.llmBaseUrl, settings.llmApiKey, model, provider, effort);
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
  // 提前计算截止字符数，避免循环内重复乘法
  const maxResultChars = maxTokens * 4;
  let result = '';
  // TODO_REMOVE: 临时诊断——排查"200 OK 但前端报标题生成失败"的根因。
  // 确认根因后删除下方三个变量及全部 [llm:title:diag] console.log。
  // 搜索 TODO_REMOVE 可快速定位所有待删点。
  const eventStats: Record<string, number> = {};
  let reasoningLen = 0;
  // 保存最近一次 error 事件文本，供诊断日志输出
  let lastError = '';
  try {
    for await (const evt of streamChat({
      messages,
      enableReasoning: false,
      temperature: opts?.temperature,
      modelOverride: opts?.modelOverride,
      maxTokens,
    })) {
      eventStats[evt.type] = (eventStats[evt.type] ?? 0) + 1;
      if (evt.type === 'content') result += evt.delta;
      if (evt.type === 'reasoning') reasoningLen += evt.delta?.length ?? 0;
      if (evt.type === 'done') break;
      if (evt.type === 'error') {
        lastError = evt.error;
        console.log('[llm:title:diag] events=', eventStats, 'resultLen=', result.length, 'reasoningLen=', reasoningLen, 'error=', lastError);
        return '';
      }
      if (result.length > maxResultChars) break; // 粗略提前停止
    }
  } catch (e) {
    console.log('[llm:title:diag] thrown=', (e as Error)?.message ?? e, 'events=', eventStats, 'resultLen=', result.length);
    return '';
  }
  // 注意：result 含 LLM 实际返回的标题内容，仅输出到本地终端，不入文件、不上传
  console.log('[llm:title:diag] events=', eventStats, 'resultLen=', result.length, 'reasoningLen=', reasoningLen, 'result=', JSON.stringify(result));
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
  // 记录入参 messages 给测试读取（INV-11 协议层 / reasoning_content 回传断言）
  recordMockLLMMessages(params.messages);

  // 从末尾向前找最后一条 user 消息，避免拷贝整个数组后反转（messages 可能含几十条历史）
  let lastUser: (typeof params.messages)[number] | undefined;
  for (let i = params.messages.length - 1; i >= 0; i--) {
    if (params.messages[i]!.role === 'user') { lastUser = params.messages[i]; break; }
  }
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
  const cannedResponse = params.isRefineTask ? REFINE_RESPONSE : params.isWriteTask ? WRITE_RESPONSE : matchResponse(userText);

  if (params.enableReasoning && cannedResponse.reasoning) {
    for (const chunk of chunkText(cannedResponse.reasoning, 8)) {
      yield { type: 'reasoning', delta: chunk };
      await sleep(30);
    }
    // 同步 yield 一份 reasoning_details 模拟 OpenRouter 结构化协议——让集成测试可以验证
    // openrouter 路径下 reasoningDetails 数组被持久化、跨轮被回灌
    if (params.provider === 'openrouter') {
      yield {
        type: 'reasoning_details',
        delta: [{
          type: 'reasoning.text',
          text: cannedResponse.reasoning,
          format: 'anthropic-claude-v1',
          id: `mock_rd_${Date.now().toString(36)}`,
          index: 0,
        }],
      };
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

// 日志里 body 摘要的最大字符数。
// 500 够看清 model/stream/temperature 等顶层字段 + messages 数组开头，
// 同时截断 prompt 正文，避免大量历史消息刷屏终端。
const LOG_BODY_PREVIEW_CHARS = 500;

// 非 2xx 错误响应体的最大字符数。
// 200 够看 OpenAI/DeepSeek 返回的 error.code + error.message，
// 同时避免 HTML 错误页全文（如 Cloudflare 502）撑满终端。
const LOG_ERROR_BODY_CHARS = 200;

// === real 实现（OpenAI 兼容协议）===
async function* realStream(
  params: StreamChatParams,
  baseUrl: string,
  apiKey: string,
  model: string,
  provider: SettingsProvider,
  effort: ThinkingEffort,
): AsyncIterable<StreamEvent> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = buildOpenAIRequestBody(params, model, provider, effort);

  // 请求发起：打印 URL + body 摘要，供排查"是否真的发出请求 + 发了哪些参数"。
  // messages 数组可能含几十条历史（几十 KB），用条数摘要替代完整序列化，
  // 避免大会话无谓把整个 messages 数组 stringify 后再丢弃。
  // apiKey 在 fetch headers 里传递，body 不含 apiKey，无需脱敏。
  const { messages: _msgs, ...restBody } = body;
  const bodyPreview = JSON.stringify({ ...restBody, messages: `[${params.messages.length} items]` })
    .slice(0, LOG_BODY_PREVIEW_CHARS);
  console.log(`[llm:req] POST ${url}`, bodyPreview);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: params.signal,
    });
  } catch (e) {
    // 网络层异常（DNS/TLS/超时/AbortError）：与 yield error 事件并行——
    // 终端能看到原始错误信息，前端 toast 仍按 classifyFetchError 的归类显示
    console.error('[llm:err] fetch failed:', (e as Error)?.message ?? e);
    yield { type: 'error', error: classifyFetchError(e, params.signal) };
    return;
  }

  // 响应状态：方便快速辨别 200 / 401 invalid_api_key / 429 rate_limit / 500 等
  console.log(`[llm:res] ${res.status} ${res.statusText} ok=${res.ok}`);

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    // 非 2xx：把 LLM 服务端返回的具体错误信息打到终端（前 200 字够看清错误码 + message）
    if (text) console.error('[llm:res:body]', text.slice(0, LOG_ERROR_BODY_CHARS));
    yield { type: 'error', error: `[${res.status}] ${text.slice(0, LOG_ERROR_BODY_CHARS)}` };
    return;
  }

  yield* consumeOpenAIStream(res.body, params.signal);
}

// 拼装 OpenAI Chat Completion 请求体。抽出避免与流读取/错误处理的控制流混在 realStream 顶层。
// export 让单测可以直接断言不同 provider 下的请求体形态
export function buildOpenAIRequestBody(
  params: StreamChatParams,
  model: string,
  provider: SettingsProvider,
  effort: ThinkingEffort,
): Record<string, unknown> {
  return {
    model,
    // OpenAI 协议字段名是 snake_case；仓库内部用 camelCase——这里做一次转换。
    // openrouter 分支额外回填 reasoning_details，让模型在多轮 + 工具调用场景下保持思考连续性
    messages: params.messages.map((m) => toOpenAIMessage(m, provider)),
    stream: true,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
    ...buildReasoningField(params.enableReasoning, provider, effort),
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
  };
}

// 按 provider 翻译 reasoning 字段。OpenRouter 与 OpenAI 推理模型都识别 reasoning.effort；
// DeepSeek-R1 通过模型名（deepseek-reasoner）自动启用思考，不需额外字段；
// 'custom' 是兜底向后兼容路径——保留旧 { enabled: true } 形态，让自定义中转端点不破坏既有行为
function buildReasoningField(
  enabled: boolean,
  provider: SettingsProvider,
  effort: ThinkingEffort,
): Record<string, unknown> {
  if (!enabled) return {};
  if (provider === 'openrouter' || provider === 'openai') {
    // OpenRouter / OpenAI 接受 effort 字符串；OpenRouter 内部会按底层 provider 翻译为
    // Anthropic 的 thinking.budget_tokens 或 Gemini 的 thinkingLevel——本侧不必关心
    return { reasoning: { effort, exclude: false } };
  }
  if (provider === 'deepseek') {
    // DeepSeek-Reasoner 通过模型名激活思考；带 reasoning 字段反而可能 400
    return {};
  }
  // custom：旧契约 { enabled: true }——既有用户/中转端点不会因 provider 字段缺失而失效
  return { reasoning: { enabled: true } };
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
function toOpenAIMessage(m: LLMMessage, provider: SettingsProvider): Record<string, unknown> {
  const msg: Record<string, unknown> = { role: m.role, content: m.content };
  // reasoning_content：DeepSeek-Reasoner 思考模式协议要求 assistant 历史消息携带；
  // 不要求的模型会忽略此字段，因此始终透传不需按模型分支判断
  if (m.reasoningContent) msg.reasoning_content = m.reasoningContent;
  // reasoning_details：仅 OpenRouter 协议要求多轮回传以维持思考连续性。
  // 其他 provider 看见此字段会按 OpenAI 兼容协议直接忽略，但部分 DeepSeek 中转端点
  // 对未知字段会 400，所以收紧到 openrouter 分支才回填
  if (provider === 'openrouter' && m.reasoningDetails && m.reasoningDetails.length > 0) {
    msg.reasoning_details = m.reasoningDetails;
  }
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
// export 让单测覆盖三家协议字段名（reasoning / reasoning_content / reasoning_details）的解析路径
export function parseSSELine(line: string, currentMsgId: string): {
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
    const events: StreamEvent[] = [
      ...extractReasoningEvents(delta),
      ...(delta.content ? [{ type: 'content', delta: delta.content } as StreamEvent] : []),
    ];
    return { events, toolCallChunks: extractToolCallChunks(delta), newMsgId };
  } catch {
    return { events: [], toolCallChunks: [], newMsgId: currentMsgId };
  }
}

// 三家协议字段名并集解析：
// - delta.reasoning_content —— DeepSeek-Reasoner 私有字段
// - delta.reasoning —— OpenRouter / Anthropic 标准化字段（字符串）
// - delta.reasoning_details —— OpenRouter 结构化数组（含 type=reasoning.text/.summary 等）
// 命中任一就拍平为纯文本 yield 'reasoning'；reasoning_details 同时单独 yield 让持久化层留底原始结构
function extractReasoningEvents(delta: Record<string, unknown>): StreamEvent[] {
  const out: StreamEvent[] = [];
  const text = extractReasoningText(delta);
  if (text) out.push({ type: 'reasoning', delta: text });
  const details = delta.reasoning_details;
  if (Array.isArray(details) && details.length > 0) {
    out.push({ type: 'reasoning_details', delta: details as ReasoningDetail[] });
  }
  return out;
}

// 单帧 reasoning 文本拍平：优先级 reasoning > reasoning_content > reasoning_details 各项 text/summary 拼接。
// 每个 SSE 帧独立返回本帧增量，由上游 buffer 处理累加
function extractReasoningText(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning === 'string' && delta.reasoning) return delta.reasoning;
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) return delta.reasoning_content;
  if (Array.isArray(delta.reasoning_details)) {
    return (delta.reasoning_details as ReasoningDetail[])
      .map((d) => (typeof d?.text === 'string' ? d.text : typeof d?.summary === 'string' ? d.summary : ''))
      .filter((s) => s.length > 0)
      .join('');
  }
  return '';
}

// 从单帧 delta 提取 tool_call delta chunks。tool_calls 协议跨多帧增量，外层按 index 累积成完整调用
function extractToolCallChunks(delta: Record<string, unknown>): ToolCallChunk[] {
  const calls = delta.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((tc) => ({
    index: tc.index ?? 0,
    id: tc.id,
    name: tc.function?.name,
    argumentsDelta: tc.function?.arguments,
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
