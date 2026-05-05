// 模块共享工具：避免 conversation / refine 等模块重复定义同一份样板。

import type { AgentStep, Message, MessageStatus, ReasoningDetail, StreamEvent } from '../types.js';
import type { PersistenceAdapter } from './persistence.js';
import * as canvas from './canvas.js';

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
 * 计算多个源节点的几何中心（多父位置的平均 + 偏移避让）。
 * 被 refine-module 和 writer-module 共享。
 */
export async function computeGeometricCenter(sourceNodeIds: string[]): Promise<{ x: number; y: number }> {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const id of sourceNodeIds) {
    const n = await canvas.getNode(id);
    if (!n) continue;
    sumX += n.positionX + 190;
    sumY += n.positionY + 100;
    count++;
  }
  if (count === 0) return { x: 0, y: 0 };
  // 偏移避让：往下 200px，让用户能看到原节点
  return { x: sumX / count - 190, y: sumY / count + 200 };
}

/**
 * 流式 assistant 消息的增量持久化：每个 SSE chunk 后调用，状态保持 streaming。
 * 每帧写整条 message 而非 diff 是因为 PersistenceAdapter.put 是"覆盖写"语义，
 * 底层 JSON 文件不支持字段级 patch；后端进程内存是单例，不会有并发写覆盖问题。
 * reasoningBuf 直接以字符串存储（不转 null），便于后续追加。
 * reasoningDetailsBuf 是 OpenRouter 结构化思考片段累积，跨轮回灌依赖此字段。
 */
export async function persistAssistantStreaming(
  p: PersistenceAdapter,
  baseMsg: Message,
  contentBuf: string,
  reasoningBuf: string,
  reasoningDetailsBuf: ReasoningDetail[],
): Promise<void> {
  await p.put('messages', baseMsg.id, {
    ...baseMsg,
    content: contentBuf,
    reasoningContent: reasoningBuf,
    // reasoningDetailsBuf 由 accumulateStreamDelta 返回的新数组引用——调用方不会再 push，
    // 无需再拷贝一份；直接传引用即可
    reasoningDetails: reasoningDetailsBuf.length > 0 ? reasoningDetailsBuf : null,
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
  reasoningDetailsBuf: ReasoningDetail[],
  status: MessageStatus,
): Promise<void> {
  await p.put('messages', baseMsg.id, {
    ...baseMsg,
    content: contentBuf,
    reasoningContent: reasoningBuf || null,
    // 同 persistAssistantStreaming：reasoningDetailsBuf 引用已不可变，无需再拷贝
    reasoningDetails: reasoningDetailsBuf.length > 0 ? reasoningDetailsBuf : null,
    status,
  });
}

/**
 * 处理流式 content / reasoning / reasoning_details 增量：累加到对应 buffer 并立即持久化。
 * handled=false 表示该 evt 不属于增量类型，调用方需自己处理（done / error 等）。
 */
export async function accumulateStreamDelta(
  evt: StreamEvent,
  p: PersistenceAdapter,
  baseMsg: Message,
  contentBuf: string,
  reasoningBuf: string,
  reasoningDetailsBuf: ReasoningDetail[],
): Promise<{ contentBuf: string; reasoningBuf: string; reasoningDetailsBuf: ReasoningDetail[]; handled: boolean }> {
  if (evt.type === 'content') {
    const next = contentBuf + evt.delta;
    await persistAssistantStreaming(p, baseMsg, next, reasoningBuf, reasoningDetailsBuf);
    return { contentBuf: next, reasoningBuf, reasoningDetailsBuf, handled: true };
  }
  if (evt.type === 'reasoning') {
    const next = reasoningBuf + evt.delta;
    await persistAssistantStreaming(p, baseMsg, contentBuf, next, reasoningDetailsBuf);
    return { contentBuf, reasoningBuf: next, reasoningDetailsBuf, handled: true };
  }
  if (evt.type === 'reasoning_details') {
    const nextDetails = [...reasoningDetailsBuf, ...evt.delta];
    await persistAssistantStreaming(p, baseMsg, contentBuf, reasoningBuf, nextDetails);
    return { contentBuf, reasoningBuf, reasoningDetailsBuf: nextDetails, handled: true };
  }
  return { contentBuf, reasoningBuf, reasoningDetailsBuf, handled: false };
}

/**
 * 流式 assistant 消息的完整消费协议：
 * 接管 buffer 累加 + 持久化 + done/error 收尾，调用方只需 `yield*` 转发事件。
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
): AsyncIterable<StreamEvent> {
  let contentBuf = '';
  let reasoningBuf = '';
  let reasoningDetailsBuf: ReasoningDetail[] = [];
  for await (const evt of source) {
    const acc = await accumulateStreamDelta(evt, p, asstMsg, contentBuf, reasoningBuf, reasoningDetailsBuf);
    contentBuf = acc.contentBuf;
    reasoningBuf = acc.reasoningBuf;
    reasoningDetailsBuf = acc.reasoningDetailsBuf;
    if (acc.handled) {
      yield evt;
      continue;
    }
    if (evt.type === 'done') {
      await persistAssistantFinal(p, asstMsg, contentBuf, reasoningBuf, reasoningDetailsBuf, 'complete');
      yield { type: 'done', messageId: asstMsg.id };
      return;
    }
    // tool_calls 是 LLM 客户端到 agent.ts 的内部事件，不应进入 conversation/refine 路径——
    // 当前两路调用方都不传 tools，理论不会收到；类型上明确忽略以防未来误用
    if (evt.type === 'tool_calls') continue;
    await persistAssistantFinal(p, asstMsg, contentBuf, reasoningBuf, reasoningDetailsBuf, 'error');
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
  // onComplete：done 之前的副作用钩子，返回的 StreamEvent 会按"先 onComplete 后 done"的顺序 yield。
  // 用于自动标题生成（D006 双轨制 · 自动轨）：每 3 轮触发一次，结果通过 'title' / 'title_error' 事件透传给前端。
  // 事件顺序硬约束（E016）：trailing 事件必须在 done 之前 yield，否则 IPC 路径下被前端丢弃。
  // 可选原因：标准对话（非标题触发轮次）不需要任何副作用，undefined 时直接跳过，避免调用方传空函数。
  onComplete?: () => Promise<StreamEvent | null>,
): AsyncIterable<StreamEvent> {
  let contentBuf = '';
  let reasoningBuf = '';
  let reasoningDetailsBuf: ReasoningDetail[] = [];
  const trace: AgentStep[] = [];
  for await (const evt of source) {
    // 1. 文本增量（与 runAssistantStream 相同路径）
    const acc = await accumulateStreamDelta(evt, p, asstMsg, contentBuf, reasoningBuf, reasoningDetailsBuf);
    contentBuf = acc.contentBuf;
    reasoningBuf = acc.reasoningBuf;
    reasoningDetailsBuf = acc.reasoningDetailsBuf;
    if (acc.handled) {
      yield evt;
      continue;
    }

    // 2. agent_* 事件：累积 trace 并实时持久化（透明性原则 D / R015）
    const traceStep = traceStepFromEvent(evt);
    if (traceStep) {
      trace.push(traceStep);
      await persistAgentTraceStreaming(p, asstMsg, contentBuf, reasoningBuf, reasoningDetailsBuf, trace);
      yield evt;
      continue;
    }

    if (evt.type === 'done') {
      await persistAgentTraceFinal(p, asstMsg, contentBuf, reasoningBuf, reasoningDetailsBuf, trace, 'complete');
      // onComplete 副作用必须在 done 之前 yield：done 是流的终止信号，前端收到即 unsubscribe（E016）
      const extra = onComplete ? await onComplete() : null;
      if (extra) yield extra;
      yield { type: 'done', messageId: asstMsg.id };
      return;
    }

    // tool_calls 内部事件——不应漏到此路径（agent.ts 已消费），防御性丢弃
    if (evt.type === 'tool_calls') continue;

    // error / 其他未识别事件 → 持久化为 error 并 yield 透传
    await persistAgentTraceFinal(p, asstMsg, contentBuf, reasoningBuf, reasoningDetailsBuf, trace, 'error');
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
  reasoningDetailsBuf: ReasoningDetail[],
  trace: AgentStep[],
): Promise<void> {
  await p.put('messages', baseMsg.id, {
    ...baseMsg,
    content: contentBuf,
    reasoningContent: reasoningBuf,
    // reasoningDetailsBuf：由 accumulateStreamDelta 返回的新引用，无需再拷贝
    reasoningDetails: reasoningDetailsBuf.length > 0 ? reasoningDetailsBuf : null,
    // trace 在外层循环被持续 push，put 是异步的——拷贝快照避免 put 尚未 settle 时
    // 外层又 push 新 step 导致同一引用指向更多数据（与落库的 "本次 step" 不一致）
    agentTrace: trace.length > 0 ? [...trace] : null,
    status: 'streaming',
  });
}

async function persistAgentTraceFinal(
  p: PersistenceAdapter,
  baseMsg: Message,
  contentBuf: string,
  reasoningBuf: string,
  reasoningDetailsBuf: ReasoningDetail[],
  trace: AgentStep[],
  status: MessageStatus,
): Promise<void> {
  await p.put('messages', baseMsg.id, {
    ...baseMsg,
    content: contentBuf,
    reasoningContent: reasoningBuf || null,
    // reasoningDetailsBuf：引用不可变，无需再拷贝
    reasoningDetails: reasoningDetailsBuf.length > 0 ? reasoningDetailsBuf : null,
    // final 时 trace 不再被修改，但为与 streaming 路径对称，显式拍快照
    agentTrace: trace.length > 0 ? [...trace] : null,
    status,
  });
}
