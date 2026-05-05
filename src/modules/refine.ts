// refine-module
// 提炼任务的两步流程：POST /api/refine 创建节点+边+流式 token，
// GET /api/refine/stream/{token} 拉取流式提炼内容。
//
// INV-2: 提炼节点继续对话时 AI 上下文不展开 inbound（这条 INV 由 conversation.assembleContext 守卫）
// INV-4: 提炼边的 child 必须是 refined 类型节点

import type { Node, Edge, LLMMessage, Message, StreamEvent } from '../types.js';
import { getPersistence } from './persistence.js';
import * as canvas from './canvas.js';
import { streamChat } from './llm-client.js';
import { getSettings } from './settings.js';
import { newId, nowIso, runAssistantStream, computeGeometricCenter } from './_utils.js';

interface PendingRefine {
  refinedNodeId: string;
  sourceNodeIds: string[];
  intent: string | null;
}

const pendingTasks = new Map<string, PendingRefine>();

export async function createRefine(params: {
  sourceNodeIds: string[];
  intentQuestion: string | null;
}): Promise<{ node: Node; edges: Edge[]; streamUrl: string }> {
  if (params.sourceNodeIds.length === 0) {
    throw new Error('sourceNodeIds required');
  }
  // 验证所有源节点存在
  for (const id of params.sourceNodeIds) {
    const n = await canvas.getNode(id);
    if (!n) throw new Error(`source node not found: ${id}`);
  }

  // 创建提炼节点
  const center = await computeGeometricCenter(params.sourceNodeIds);
  const refinedNode = await canvas.createNode({
    positionX: center.x,
    positionY: center.y,
    type: 'refined',
  });
  // 标题按 meta 格式（"提炼·来自 N 节点"），不再被 LLM 输出首行覆盖
  // 这样折叠态的元数据栏自描述充足，不需要等流式完成
  await canvas.patchNode(refinedNode.id, {
    title: `提炼·${params.sourceNodeIds.length} 节点`,
  });

  // 创建多父边（INV-4：每条都指向同一个 refined 节点）
  const edges: Edge[] = [];
  for (const srcId of params.sourceNodeIds) {
    const e = await canvas.createEdge({
      parentNodeId: srcId,
      childNodeId: refinedNode.id,
      edgeKind: 'refine_input',
      inheritedUntilSequence: null, // 提炼边无快照点
    });
    edges.push(e);
  }

  // 注册流式任务（一次性 token）
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
  pendingTasks.set(token, {
    refinedNodeId: refinedNode.id,
    sourceNodeIds: params.sourceNodeIds,
    intent: params.intentQuestion ?? null,
  });
  // token 30 秒过期
  setTimeout(() => pendingTasks.delete(token), 30_000);

  return {
    node: { ...refinedNode, title: '提炼中…' },
    edges,
    streamUrl: `/api/refine/stream/${token}`,
  };
}

// 取所有源节点的 messages，剥离 reasoning（INV-11），拼装成提炼任务输入。
// Prompt 严格按视觉规范文档 §4.2，遵守 R010（不出现画布/节点/提炼概念）+ R011（强制四栏）。
async function assembleRefineInput(task: PendingRefine): Promise<LLMMessage[]> {
  const p = getPersistence();
  const sections: string[] = [];
  for (let i = 0; i < task.sourceNodeIds.length; i++) {
    const nodeId = task.sourceNodeIds[i]!;
    const node = await canvas.getNode(nodeId);
    if (!node) continue;
    const messages = await p.list<Message>('messages', (m) => m.nodeId === nodeId);
    messages.sort((a, b) => a.sequence - b.sequence);
    const text = messages
      .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
      .join('\n\n');
    // R010 守卫：node.title 在提炼节点上是 "提炼·N 节点" 的内部命名，
    // 直接透传会让 AI 看到产品概念。这里在递归提炼场景下做一次脱敏。
    const rawTitle = node.title ?? `材料 ${i + 1}`;
    const safeTitle = rawTitle.startsWith('提炼·') ? `材料 ${i + 1}` : rawTitle;
    sections.push(`【材料 ${i + 1}：${safeTitle}】\n${text}`);
  }
  const materialBlock = sections.join('\n\n');

  // 模式 A：用户填写了具体问题；模式 B：留空走综合提炼
  const intro = task.intent
    ? `请基于以下材料，回答这个问题：「${task.intent}」`
    : '请基于以下材料，做综合性提炼。';

  return [
    { role: 'system', content: REFINE_SYSTEM_PROMPT },
    { role: 'user', content: `${intro}\n\n材料如下：\n\n${materialBlock}` },
  ];
}

const REFINE_SYSTEM_PROMPT = `你是一名研究助理，正在为一份内部备忘录撰写要点。

用户会给你一段或多段讨论材料。你的任务是从材料中提炼出一份结构化的纲要。

输出格式：

【核心结论】
1-2 句最重要的判断。

【关键论据】
3-5 个要点。每点尽量带具体的数据、事实、或引用。

【未解决 / 待验证】
讨论中没有结论的部分，依赖外部信息才能解答的部分。
（这一栏必须保留。诚实承认认知边界，比假装一切已清晰更有价值。）

【可能的下一步】
1-2 个值得继续推进的方向。

要求：

- 总长度不超过 400 字。
- 客观、紧凑的语言。避免修辞和形容词堆砌。
- 识别多段材料之间的共同点、矛盾点、依赖关系。
- 不要为了出结论而硬出结论。如果材料不充分，明确说"基于现有材料无法判断 X"。
- 直接输出纲要，不要寒暄、不要"以下是您要的提炼"这种前缀。`;

// 流式拉取提炼内容（一次性 token 消费后失效）
export async function* streamRefine(token: string): AsyncIterable<StreamEvent> {
  const task = pendingTasks.get(token);
  if (!task) {
    yield { type: 'error', error: 'token_not_found' };
    return;
  }
  pendingTasks.delete(token);

  const p = getPersistence();
  const settings = await getSettings();

  // 创建提炼节点的 assistant 消息（流式累积）
  const asstMsg: Message = {
    id: newId('m'),
    nodeId: task.refinedNodeId,
    role: 'assistant',
    content: '',
    reasoningContent: '',
    reasoningDetails: null,
    sequence: 0,
    status: 'streaming',
    wasResumed: false,
    createdAt: nowIso(),
  };
  await p.put('messages', asstMsg.id, asstMsg);
  canvas.markStreaming(task.refinedNodeId);

  try {
    const messages = await assembleRefineInput(task);
    // title 在 createRefine 时已按 "提炼·N 节点" 设定，不需要在 done 后追加额外事件
    yield* runAssistantStream(
      streamChat({
        messages,
        enableReasoning: settings.thinkingModeEnabled,
        thinkingEffort: settings.thinkingEffort,
        provider: settings.provider,
        isRefineTask: true,
        temperature: 0.3,
      }),
      p,
      asstMsg,
    );
  } finally {
    canvas.unmarkStreaming(task.refinedNodeId);
  }
}
