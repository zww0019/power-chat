// conversation-module
// 节点内消息发送 + 上下文组装（关键 INV 守卫所在）+ 分支动作 + 标题自动生成。
//
// INV-1: 节点对话上下文 = 该节点所有 Message + 入边携带的继承内容
// INV-2: refined 类型节点不展开 inbound edges 取原节点内容（只用自己的 messages）
// INV-3: 分支边的 inheritedUntilSequence immutable
// INV-8: Message.sequence 严格单调
// INV-11（修正后）: reasoningContent 按协议要求传递（DeepSeek-Reasoner 要求多轮回传）；
//                   agentTrace 永不进入下游（R019 协议无关守卫）—— 详见 toLLMMessage 注释

import type { Message, Node, Edge, LLMMessage, StreamEvent } from '../types.js';
import { getPersistence } from './persistence.js';
import * as canvas from './canvas.js';
import { completeChat } from './llm-client.js';
import { getSettings } from './settings.js';
import { newId, nowIso, runAgentAssistantStream } from './_utils.js';
import { runAgentLoop } from './agent.js';
import { registerAbortController, unregisterAbortController } from './abort-registry.js';

// 取节点的所有 messages，按 sequence 升序
async function getMessagesOfNode(nodeId: string): Promise<Message[]> {
  const all = await getPersistence().list<Message>('messages', (m) => m.nodeId === nodeId);
  return all.sort((a, b) => a.sequence - b.sequence);
}

// === 核心函数：上下文组装（INV 守卫的关键代码）===
//
// 对话节点：递归向上 join 父链 messages（按 inheritedUntilSequence 截止）
// 提炼节点：仅本节点 messages，不展开 inbound（INV-2）
// 输出：LLMMessage[]，reasoningContent 按协议透传（INV-11 修正后语义）；
//       agentTrace 永不写入 LLMMessage（R019 协议无关守卫，由 toLLMMessage 白名单保证）
export async function assembleContext(nodeId: string): Promise<LLMMessage[]> {
  const node = await canvas.getNode(nodeId);
  if (!node) return [];

  // INV-2: refined 节点不展开父链
  if (node.type === 'refined') {
    const own = await getMessagesOfNode(nodeId);
    return own.map(toLLMMessage); // agentTrace 已过滤（白名单保证）；reasoningContent 透传
  }

  // dialogue 节点：从父链回溯
  // 注意：仅取 edgeKind='branch' 的入边（refine_input 不应出现在 dialogue 节点上）
  const inboundEdges = await canvas.getEdgesOfChild(nodeId);
  const branchEdges = inboundEdges.filter((e) => e.edgeKind === 'branch');

  // dialogue 节点逻辑上有 0 或 1 条 branch 入边
  // 多条不应发生（创建分支只产生一条边），但容错处理：取第一条
  let inheritedMessages: LLMMessage[] = [];
  if (branchEdges.length > 0) {
    const edge = branchEdges[0]!;
    const parentMessages = await getMessagesOfNode(edge.parentNodeId);
    // INV-3: 截止到 inheritedUntilSequence 那条消息（含）
    const limit = edge.inheritedUntilSequence;
    const truncated = limit === null ? parentMessages : parentMessages.filter((m) => m.sequence <= limit);
    // 递归向上拼上父节点的继承上下文
    const parentInherited = await assembleContext(edge.parentNodeId);
    // 父节点的继承 + 父节点截止快照前的消息（去重：assembleContext 已经包含了父节点的 messages）
    // 简化策略：parentInherited 已经包含父节点的完整组装结果——但它也包含了父节点 ALL 自己的 messages，
    // 这与"截止到某 sequence"冲突。所以重写：
    // 正确做法：从 parentNode 的 truncated 消息向上递归
    inheritedMessages = await assembleContextWithLimit(edge.parentNodeId, limit);
  }

  const own = await getMessagesOfNode(nodeId);
  return [...inheritedMessages, ...own.map(toLLMMessage)];
}

// 内部：带 sequence 上限的上下文组装（用于父链回溯，INV-3）
async function assembleContextWithLimit(
  nodeId: string,
  untilSequence: number | null,
): Promise<LLMMessage[]> {
  const node = await canvas.getNode(nodeId);
  if (!node) return [];

  if (node.type === 'refined') {
    // 提炼节点没有 sequence 截止概念（它本身是减熵起点）
    const own = await getMessagesOfNode(nodeId);
    return own.map(toLLMMessage);
  }

  const inboundEdges = await canvas.getEdgesOfChild(nodeId);
  const branchEdges = inboundEdges.filter((e) => e.edgeKind === 'branch');
  let inherited: LLMMessage[] = [];
  if (branchEdges.length > 0) {
    const edge = branchEdges[0]!;
    inherited = await assembleContextWithLimit(edge.parentNodeId, edge.inheritedUntilSequence);
  }

  const own = await getMessagesOfNode(nodeId);
  const truncated = untilSequence === null ? own : own.filter((m) => m.sequence <= untilSequence);
  return [...inherited, ...truncated.map(toLLMMessage)];
}

// 关键守卫：把 Message 转成 LLMMessage，按协议要求决定每个字段是否回传。
//
// 设计上仍是"白名单 select 字段"——未来给 Message 新增任何业务字段（agentTrace / sequence /
// status / wasResumed / createdAt / nodeId / id 等）都不会因忘加 delete 而泄漏到下游 LLM 输入。
//
// 字段语义辨析（M5 后修正 INV-11 的混淆语义）：
// - agentTrace（R019 / 协议无关守卫）：thought/action/observation 序列是 agent 内部记录，
//   不是 LLM 协议字段；任何模型下都不应回传——这条永远成立。
// - reasoningContent（按协议要求传递）：DeepSeek-Reasoner / Anthropic Extended Thinking
//   要求多轮调用携带历史 assistant 的 reasoning_content（不带会 400 invalid_request_error）；
//   OpenAI o1 系列服务端管理状态不需客户端回传。是否真正写入请求体由 llm-client 的
//   toOpenAIMessage 决定——这里只负责把数据透传到协议层。
function toLLMMessage(m: Message): LLMMessage {
  const out: LLMMessage = { role: m.role, content: m.content };
  if (m.reasoningContent) out.reasoningContent = m.reasoningContent;
  return out;
}

// === 节点内发消息（流式）===
export interface SendMessageParams {
  nodeId: string;
  content: string;
}

export async function* sendMessage(params: SendMessageParams): AsyncIterable<StreamEvent> {
  const node = await canvas.getNode(params.nodeId);
  if (!node) {
    yield { type: 'error', error: `node_not_found: ${params.nodeId}` };
    return;
  }

  const p = getPersistence();
  const existing = await getMessagesOfNode(params.nodeId);
  const nextSeq = (existing[existing.length - 1]?.sequence ?? -1) + 1;

  // 1. 持久化 user 消息
  const userMsg: Message = {
    id: newId('m'),
    nodeId: params.nodeId,
    role: 'user',
    content: params.content,
    reasoningContent: null,
    sequence: nextSeq,
    status: 'complete',
    wasResumed: false,
    createdAt: nowIso(),
  };
  await p.put('messages', userMsg.id, userMsg);

  // 2. 创建 assistant 占位消息
  const asstMsg: Message = {
    id: newId('m'),
    nodeId: params.nodeId,
    role: 'assistant',
    content: '',
    reasoningContent: '',
    sequence: nextSeq + 1,
    status: 'streaming',
    wasResumed: false,
    createdAt: nowIso(),
  };
  await p.put('messages', asstMsg.id, asstMsg);

  // 3. 标记节点流式中（INV-7：streaming 节点不可删除）+ 注册 AbortController（M5 中断闭环）
  canvas.markStreaming(params.nodeId);
  const abortCtrl = new AbortController();
  registerAbortController(params.nodeId, abortCtrl);

  try {
    // 4. 组装上下文（关键 INV 锚点）
    const messages = await assembleContext(params.nodeId);
    const settings = await getSettings();

    // 5. 在 messages 头部注入"思考伙伴"system prompt（R010 守卫：不出现画布概念）
    // agent loop 会在内部根据 tool 模式追加工具引导 prompt（R014/R017）
    const messagesWithSystem: LLMMessage[] = [
      { role: 'system', content: CONVERSATION_SYSTEM_PROMPT },
      ...messages,
    ];

    // 6. 流式调 agent loop。LLM 决定不调工具时退化为单轮普通对话——
    // 现有"无工具触发词"的对话路径行为与 M2a 之前完全一致（agent loop 会直接 yield content + done）
    yield* runAgentAssistantStream(
      runAgentLoop({
        initialMessages: messagesWithSystem,
        enableReasoning: settings.thinkingModeEnabled,
        temperature: 0.7,
        signal: abortCtrl.signal,
      }),
      p,
      asstMsg,
      // 标题节流：每 3 轮（user+assistant 共 6 条 message）触发一次（D006）
      async () => {
        const totalMessages = nextSeq + 2;
        if (totalMessages % 6 !== 0) return null;
        const newTitle = await updateNodeTitle(params.nodeId).catch(() => null);
        return newTitle ? { type: 'title', nodeId: params.nodeId, title: newTitle } : null;
      },
    );
  } finally {
    unregisterAbortController(params.nodeId);
    canvas.unmarkStreaming(params.nodeId);
  }
}

// 节点标题生成（每 3 轮触发，详见 D006 / R012）
// 用 settings.llmFastModel 优先，留空回退主模型；temperature=0.2 / max_tokens=30
async function updateNodeTitle(nodeId: string): Promise<string | null> {
  const messages = await getMessagesOfNode(nodeId);
  if (messages.length === 0) return null;
  const dialogueText = messages
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
    .join('\n\n');

  const settings = await getSettings();
  const promptMessages: LLMMessage[] = [
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    { role: 'user', content: `请用 8-15 字概括以下对话的主题：\n\n${dialogueText}` },
  ];
  const title = await completeChat(promptMessages, {
    maxTokens: 30,
    temperature: 0.2,
    modelOverride: settings.llmFastModel || undefined,
  });
  if (!title) return null;
  // 清理常见 LLM 噪音：去前后空白、引号、句末标点
  const cleaned = title.trim().replace(/^[「『"'\s]+|[」』"'\s。.！!？?]+$/g, '').slice(0, 30);
  if (!cleaned) return null;
  await canvas.patchNode(nodeId, { title: cleaned });
  return cleaned;
}

// === Prompt 模板（来自视觉规范文档 §4.1 / §4.3）===
// 关键约束（R010）：禁止出现"画布""节点""分支""提炼"等产品概念

const CONVERSATION_SYSTEM_PROMPT = `你是一名思考伙伴。

你正在和一位认真的研究者交谈——他可能是分析师、写作者、产品决策人或学者。他需要的不是答主，是一个能反射他的想法、戳穿他的逻辑漏洞、提供他缺失的事实背景的对话者。

风格：

- 简洁。默认回答 100-250 字。除非用户明确要求展开，否则不写长答案。
- 像聪明同事说话，不要客服腔。不要"非常棒的问题"、"很高兴为您解答"这类话术。直接进入内容。
- 敢于反驳。当用户的判断有逻辑漏洞或事实错误时直接指出，不要迂回，不要先表扬再批评。
- 承认不知道。当缺乏信息时直接说"我不知道"或"这超出我能确认的范围"，不要编造。
- 可以在回答末尾留一个值得追问的引子，但只在真有价值时给——不要每次都机械附加。

专注当下的对话内容。`;

const TITLE_SYSTEM_PROMPT = `你是一个文本概括助手。

用户会给你一段对话内容。你需要用 8 到 15 个汉字概括这段对话的核心主题。

要求：

- 输出只有一个短句，不带标点结尾，不带任何解释或前缀。
- 抓主题，不抓具体结论——因为对话还可能继续。
- 用名词性短语，不用动词性句子。
  - 好：「东南亚消费习惯差异」
  - 坏：「讨论了东南亚消费习惯差异」
- 中文输出。`;

// === 分支动作 ===
export async function branchNode(params: {
  parentNodeId: string;
  fromMessageId: string;
}): Promise<{ node: Node; edge: Edge }> {
  const parent = await canvas.getNode(params.parentNodeId);
  if (!parent) throw new Error(`parent node not found: ${params.parentNodeId}`);

  // 找到 fromMessageId 所在的 sequence
  const messages = await getMessagesOfNode(params.parentNodeId);
  const fromMsg = messages.find((m) => m.id === params.fromMessageId);
  if (!fromMsg) {
    throw new Error(`fromMessageId not found in parent: ${params.fromMessageId}`);
  }

  // 子节点位置：父节点右侧偏移
  const childNode = await canvas.createNode({
    positionX: parent.positionX + 440,
    positionY: parent.positionY,
    type: 'dialogue',
  });

  // INV-3: inheritedUntilSequence 写入 fromMsg.sequence，immutable
  const edge = await canvas.createEdge({
    parentNodeId: params.parentNodeId,
    childNodeId: childNode.id,
    edgeKind: 'branch',
    inheritedUntilSequence: fromMsg.sequence,
  });

  return { node: childNode, edge };
}
