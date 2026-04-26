// 模块共享工具：避免 conversation / refine 等模块重复定义同一份样板。

import type { AgentStep, Message, MessageStatus, StreamEvent } from '../types.js';
import type { PersistenceAdapter } from './persistence.js';

/** 生成业务 id：前缀 + 时间戳 base36 + 随机 base36 */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 当前时间的 ISO 字符串（统一时间戳格式） */
export const nowIso = (): string => new Date().toISOString();

/** 把字符串按固定块大小切分。多模块共享（mock 流式 / agent react_text 流式回放等场景，D010）。 */
export function chunkText(text: string, perChunk: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += perChunk) out.push(text.slice(i, i + perChunk));
  return out;
}

/**
 * 流式 assistant 消息的增量持久化：每个 SSE chunk 后调用，状态保持 streaming。
 * reasoningBuf 直接以字符串存储（不转 null），便于后续追加。
 */
export async function persistAssistantStreaming(
  p: PersistenceAdapter,
  baseMsg: Message,
  contentBuf: string,
  reasoningBuf: string,
): Promise<void> {
  await p.put('messages', baseMsg.id, {
    ...baseMsg,
    content: contentBuf,
    reasoningContent: reasoningBuf,
    status: 'streaming',
  });
}

/**
 * 流式 assistant 消息的最终持久化：用累积的 contentBuf / reasoningBuf
 * 覆盖原占位消息，状态置为 complete 或 error。空 reasoningBuf 转为 null。
 * 抽出此函数避免 conversation.sendMessage 与 refine.streamRefine 各自手写一份。
 */
export async function persistAssistantFinal(
  p: PersistenceAdapter,
  baseMsg: Message,
  contentBuf: string,
  reasoningBuf: string,
  status: MessageStatus,
): Promise<void> {
  await p.put('messages', baseMsg.id, {
    ...baseMsg,
    content: contentBuf,
    reasoningContent: reasoningBuf || null,
    status,
  });
}

/**
 * 处理流式 content / reasoning 增量：累加到对应 buffer 并立即持久化。
 * handled=false 表示该 evt 不属于增量类型，调用方需自己处理（done / error 等）。
 */
export async function accumulateStreamDelta(
  evt: StreamEvent,
  p: PersistenceAdapter,
  baseMsg: Message,
  contentBuf: string,
  reasoningBuf: string,
): Promise<{ contentBuf: string; reasoningBuf: string; handled: boolean }> {
  if (evt.type === 'content') {
    const next = contentBuf + evt.delta;
    await persistAssistantStreaming(p, baseMsg, next, reasoningBuf);
    return { contentBuf: next, reasoningBuf, handled: true };
  }
  if (evt.type === 'reasoning') {
    const next = reasoningBuf + evt.delta;
    await persistAssistantStreaming(p, baseMsg, contentBuf, next);
    return { contentBuf, reasoningBuf: next, handled: true };
  }
  return { contentBuf, reasoningBuf, handled: false };
}

/**
 * 流式 assistant 消息的完整消费协议：
 * 接管 buffer 累加 + 持久化 + done/error 收尾，调用方只需 `yield*` 转发事件。
 *
 * `onComplete` 可选：done 后异步触发的副作用（如标题生成），返回的 StreamEvent
 * 会附加在 done 事件之后透传给客户端。
 *
 * 错误语义：收到 error 事件时 yield 后立即 return，不抛异常——调用方（HTTP handler）
 * 只需消费 SSE 流，不用 try-catch 本函数；真正的网络/系统异常由上层 try-finally 捕获。
 *
 * 抽出此 generator 让 conversation.sendMessage 与 refine.streamRefine 不再
 * 各自手写一份 for-await + content/reasoning/done/error 的状态机模板。
 */
export async function* runAssistantStream(
  source: AsyncIterable<StreamEvent>,
  p: PersistenceAdapter,
  asstMsg: Message,
  onComplete?: () => Promise<StreamEvent | null>,
): AsyncIterable<StreamEvent> {
  let contentBuf = '';
  let reasoningBuf = '';
  for await (const evt of source) {
    const acc = await accumulateStreamDelta(evt, p, asstMsg, contentBuf, reasoningBuf);
    contentBuf = acc.contentBuf;
    reasoningBuf = acc.reasoningBuf;
    if (acc.handled) {
      yield evt;
      continue;
    }
    if (evt.type === 'done') {
      await persistAssistantFinal(p, asstMsg, contentBuf, reasoningBuf, 'complete');
      yield { type: 'done', messageId: asstMsg.id };
      const extra = onComplete ? await onComplete() : null;
      if (extra) yield extra;
      return;
    }
    // tool_calls 是 LLM 客户端到 agent.ts 的内部事件，不应进入 conversation/refine 路径——
    // 当前两路调用方都不传 tools，理论不会收到；类型上明确忽略以防未来误用
    if (evt.type === 'tool_calls') continue;
    await persistAssistantFinal(p, asstMsg, contentBuf, reasoningBuf, 'error');
    yield evt;
    return;
  }
}

/**
 * agent loop 版本的流式消费协议：在 runAssistantStream 基础上额外累积 agentTrace
 * 并实时持久化（每个 step 落库一次，对应 R015 透明性要求）。
 *
 * trace 条目从 SSE 事件重建：
 * - agent_action → trace.action（通过事件中的 stepId / toolCallId / toolName / toolArgs）
 * - agent_observation → trace.observation
 * - agent_final → trace.final
 *
 * agent_thought 事件 M2b 暂未使用（thought 性质内容直接走 content 路径），future-proof 保留处理。
 */
export async function* runAgentAssistantStream(
  source: AsyncIterable<StreamEvent>,
  p: PersistenceAdapter,
  asstMsg: Message,
  onComplete?: () => Promise<StreamEvent | null>,
): AsyncIterable<StreamEvent> {
  let contentBuf = '';
  let reasoningBuf = '';
  const trace: AgentStep[] = [];
  for await (const evt of source) {
    // 1. 文本增量（与 runAssistantStream 相同路径）
    const acc = await accumulateStreamDelta(evt, p, asstMsg, contentBuf, reasoningBuf);
    contentBuf = acc.contentBuf;
    reasoningBuf = acc.reasoningBuf;
    if (acc.handled) {
      yield evt;
      continue;
    }

    // 2. agent_* 事件：累积 trace 并实时持久化（透明性原则 D / R015）
    const traceStep = traceStepFromEvent(evt);
    if (traceStep) {
      trace.push(traceStep);
      await persistAgentTraceStreaming(p, asstMsg, contentBuf, reasoningBuf, trace);
      yield evt;
      continue;
    }

    if (evt.type === 'done') {
      await persistAgentTraceFinal(p, asstMsg, contentBuf, reasoningBuf, trace, 'complete');
      yield { type: 'done', messageId: asstMsg.id };
      const extra = onComplete ? await onComplete() : null;
      if (extra) yield extra;
      return;
    }

    // tool_calls 内部事件——不应漏到此路径（agent.ts 已消费），防御性丢弃
    if (evt.type === 'tool_calls') continue;

    // error / 其他未识别事件 → 持久化为 error 并 yield 透传
    await persistAgentTraceFinal(p, asstMsg, contentBuf, reasoningBuf, trace, 'error');
    yield evt;
    return;
  }
}

// 把 agent_* SSE 事件还原为 AgentStep 形态；非 agent 事件返回 null
function traceStepFromEvent(evt: StreamEvent): AgentStep | null {
  if (evt.type === 'agent_action') {
    return {
      id: evt.stepId,
      type: 'action',
      toolCallId: evt.toolCallId,
      toolName: evt.toolName,
      toolArgs: evt.toolArgs,
      timestamp: nowIso(),
    };
  }
  if (evt.type === 'agent_observation') {
    return {
      id: evt.stepId,
      type: 'observation',
      toolCallId: evt.toolCallId,
      success: evt.success,
      result: evt.result,
      errorReason: evt.errorReason,
      truncated: evt.truncated,
      timestamp: nowIso(),
    };
  }
  if (evt.type === 'agent_final') {
    return {
      id: newId('step'),
      type: 'final',
      reason: evt.reason,
      timestamp: nowIso(),
    };
  }
  return null;
}

async function persistAgentTraceStreaming(
  p: PersistenceAdapter,
  baseMsg: Message,
  contentBuf: string,
  reasoningBuf: string,
  trace: AgentStep[],
): Promise<void> {
  await p.put('messages', baseMsg.id, {
    ...baseMsg,
    content: contentBuf,
    reasoningContent: reasoningBuf,
    agentTrace: trace.length > 0 ? [...trace] : null,
    status: 'streaming',
  });
}

async function persistAgentTraceFinal(
  p: PersistenceAdapter,
  baseMsg: Message,
  contentBuf: string,
  reasoningBuf: string,
  trace: AgentStep[],
  status: MessageStatus,
): Promise<void> {
  await p.put('messages', baseMsg.id, {
    ...baseMsg,
    content: contentBuf,
    reasoningContent: reasoningBuf || null,
    agentTrace: trace.length > 0 ? [...trace] : null,
    status,
  });
}
