// conversation-module
// 节点内消息发送 + 上下文组装（关键 INV 守卫所在）+ 分支动作 + 用户主动触发的标题生成。
//
// INV-1: 节点对话上下文 = 该节点所有 Message + 入边携带的继承内容
// INV-2: refined / written 类型节点不展开 inbound edges 取原节点内容（只用自己的 messages）
// INV-3: 分支边的 inheritedUntilSequence immutable
// INV-8: Message.sequence 严格单调
// INV-11（修正后）: reasoningContent 按协议要求传递（DeepSeek-Reasoner 要求多轮回传）；
//                   agentTrace 永不进入下游（R019 协议无关守卫）—— 详见 toLLMMessage 注释

import type { Message, Node, Edge, LLMMessage, StreamEvent } from '../types.js';
import { MessageReferencedByBranchError, NodeNotFoundError, NoMessagesForTitleError, NotConfiguredError, StreamingNodeError, TitleGenerationFailedError } from '../types.js';
import { getPersistence } from './persistence.js';
import * as canvas from './canvas.js';
import { completeChat } from './llm-client.js';
import { getSettings } from './settings.js';
import { newId, nowIso, runAgentAssistantStream } from './_utils.js';
import { runAgentLoop } from './agent.js';
import { registerAbortController, unregisterAbortController } from './abort-registry.js';
import * as cognitionClient from './cognition-client.js';

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

  // INV-2: refined / written 节点不展开父链
  if (node.type === 'refined' || node.type === 'written') {
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

  if (node.type === 'refined' || node.type === 'written') {
    // 提炼/撰写节点没有 sequence 截止概念（它本身是减熵起点）
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
  // reasoningDetails 跨轮回传（仅 OpenRouter 在 toOpenAIMessage 真正写入请求体）：
  // 即便用户后来切到其他 provider，本字段在 LLMMessage 上无副作用——会被静默忽略
  if (m.reasoningDetails && m.reasoningDetails.length > 0) out.reasoningDetails = m.reasoningDetails;
  // personaVersion 透传供 cognition-client 构造 turns 时识别历史 assistant 输出来自哪个画像周期
  // toOpenAIMessage 不读此字段——不会进入真实 LLM 请求体
  if (m.personaVersion) out.personaVersion = m.personaVersion;
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
  // 提炼/撰写节点不再支持直接追问：UI 上已用"继续追问"按钮替换输入框（孵化对话子节点继承输出）。
  // 后端守卫为防御层——前端绕过/旧客户端误调时统一拒绝，避免破坏"提炼/撰写即终态"的语义。
  if (node.type === 'refined' || node.type === 'written') {
    yield { type: 'error', error: 'cannot_send_to_refined_or_written_node' };
    return;
  }

  const p = getPersistence();
  const existing = await getMessagesOfNode(params.nodeId);
  const nextSeq = (existing[existing.length - 1]?.sequence ?? -1) + 1;

  // 0. 取 cognition 缓存 personaPrompt + version（异步缓存策略：零延迟读上次 cycle 结果）
  const inj = await cognitionClient.getCachedInjection();

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
  // 立刻把后端真实 user 消息 ID 下发给前端替换乐观 ID，否则用户对刚发的消息发起 branch
  // 或 edit 时，前端持有的乐观 ID 在后端查不到 → 400 not_found。
  yield { type: 'user_persisted', messageId: userMsg.id };

  // 2. 创建 assistant 占位消息（写入当前 cognition 画像 version 用于反污染）
  const asstMsg: Message = {
    id: newId('m'),
    nodeId: params.nodeId,
    role: 'assistant',
    content: '',
    reasoningContent: '',
    reasoningDetails: null,
    personaVersion: inj.personaVersion,
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

    // 4a. 后台触发 cognition 反思循环（异步缓存策略：fire-and-forget，不阻塞主对话；
    // 结果写入 settings 缓存，下一轮 sendMessage 即可用上新 personaPrompt）。
    // cognitionEnabled=false / 服务不可达时内部静默 no-op
    void cognitionClient.fireAsyncCycle(
      cognitionClient.buildCycleTurns(messages, params.content, inj.personaVersion),
    );

    // 5. 在 messages 头部注入"思考伙伴"system prompt（R010 守卫：不出现画布概念）+ cognition 行为指令
    // agent loop 会在内部根据 tool 模式追加工具引导 prompt（R014/R017）
    const messagesWithSystem: LLMMessage[] = [
      {
        role: 'system',
        content: cognitionClient.composeSystemPrompt(CONVERSATION_SYSTEM_PROMPT, inj.personaPrompt),
      },
      ...messages,
    ];

    // 6. 流式调 agent loop。LLM 决定不调工具时退化为单轮普通对话——
    // 现有"无工具触发词"的对话路径行为与 M2a 之前完全一致（agent loop 会直接 yield content + done）
    yield* runAgentAssistantStream(
      runAgentLoop({
        initialMessages: messagesWithSystem,
        enableReasoning: settings.thinkingModeEnabled,
        thinkingEffort: settings.thinkingEffort,
        provider: settings.provider,
        temperature: 0.7,
        signal: abortCtrl.signal,
      }),
      p,
      asstMsg,
      // D006 双轨制 · 自动轨：每 3 轮（6 条 message）触发一次标题重生。
      // 触发条件用"实际消息条数 % 6"而非 sequence 偏移——节点经过截断式删除（E019）后，
      // sequence 跨过 6 整除位会让旧的 (nextSeq+2)%6 永远不再触发，是用户当初痛点的根因。
      // 改用 length 直接计数从根上规避此问题。
      // 失败处理：领域错误转成简化 code 通过 title_error 事件给前端 toast（不再静默吞错）。
      // 永远强制覆盖（用户已确认接受）：不检查 node.title 是否已有值。
      async () => {
        // 必须重新查而非复用入口处的 existing 快照：streaming 期间 user 消息和 assistant 消息
        // 都已持久化，existing 是流式开始前的旧快照，count 偏小会导致触发条件漏判。
        const all = await getMessagesOfNode(params.nodeId);
        if (all.length < 6 || all.length % 6 !== 0) return null;
        try {
          const { title } = await regenerateNodeTitle(params.nodeId);
          return { type: 'title', nodeId: params.nodeId, title };
        } catch (e) {
          const code = classifyTitleError(e);
          return { type: 'title_error', nodeId: params.nodeId, error: code };
        }
      },
    );
  } finally {
    unregisterAbortController(params.nodeId);
    canvas.unmarkStreaming(params.nodeId);
  }
}

// 把 regenerateNodeTitle 抛出的领域异常归类成与 HTTP 路由层对齐的简化 code，
// 让前端可以用同一套字符串匹配（empty_node / not_configured / llm_failed）映射 toast 文案。
//
// 共用同一组 code 的原因（D006 双轨制设计意图）：
// 自动轨（title_error 事件）和主动轨（HTTP 路由层的错误响应）在前端的 toast 处理
// 走同一份映射函数 titleErrorMessage，所以两条路径必须输出语义一致的 code——
// 在此统一归类，避免两处各自定义 code 字符串后逐渐出现拼写/语义漂移。
function classifyTitleError(e: unknown): string {
  if (e instanceof NoMessagesForTitleError) return 'empty_node';
  if (e instanceof NotConfiguredError) return 'not_configured';
  if (e instanceof TitleGenerationFailedError) return 'llm_failed';
  if (e instanceof NodeNotFoundError) return 'not_found';
  return 'unknown';
}

// 用户主动触发的节点标题重新生成（点击节点标题旁的刷新图标）。
// 设计：永远强制重新生成（即使 node.title 已有值），由用户的点击意图决定。
// 失败：抛出领域错误（NodeNotFoundError / NoMessagesForTitleError / TitleGenerationFailedError）
//       或透传 LLM 层异常，由路由层（mock-server / ipc.ts）映射成 4xx / 5xx，前端 toast 显示原因。
//
// 用快模型 settings.llmFastModel 优先，留空回退主模型；temperature=0.2 / max_tokens=30。
export async function regenerateNodeTitle(nodeId: string): Promise<{ title: string }> {
  const node = await canvas.getNode(nodeId);
  if (!node) {
    throw new NodeNotFoundError(nodeId);
  }
  const messages = await getMessagesOfNode(nodeId);
  if (messages.length === 0) {
    throw new NoMessagesForTitleError();
  }
  const dialogueText = messages
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
    .join('\n\n');

  const settings = await getSettings();
  const promptMessages: LLMMessage[] = [
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    { role: 'user', content: `请用 8-15 字概括以下对话的主题：\n\n${dialogueText}` },
  ];
  const raw = await completeChat(promptMessages, {
    maxTokens: 30,
    temperature: 0.2,
    modelOverride: settings.llmFastModel || undefined,
  });
  // 清理常见 LLM 噪音：去前后空白、引号、句末标点
  const cleaned = raw.trim().replace(/^[「『"'\s]+|[」』"'\s。.！!？?]+$/g, '').slice(0, 30);
  if (!cleaned) {
    throw new TitleGenerationFailedError('LLM 未返回有效标题（可能是快模型配置错误或不可达）');
  }
  await canvas.patchNode(nodeId, { title: cleaned });
  return { title: cleaned };
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

// === 截断式删除消息（用户编辑触发，详见 domain/edge-cases E019）===
//
// 删除该节点 sequence ≥ fromSequence 的所有 messages。
// 三层守卫：
// (a) 流式中节点拒绝（INV-7 思路扩展）；(b) 被任一分支引用拒绝（2c 硬阻断）；
// (c) 调用方负责 fromSequence 合法性（≥ 0）。
//
// 守卫顺序：先查 streaming → 再查分支引用 → 再实际删除。
export async function truncateMessages(nodeId: string, fromSequence: number): Promise<number> {
  if (canvas.isStreaming(nodeId)) {
    throw new StreamingNodeError(nodeId);
  }
  // 分支引用守卫：任一出边 branch 的 inheritedUntilSequence ≥ fromSequence 都意味着
  // 子分支引用了"将被清空"范围内的消息——拒绝操作避免 silent context corruption。
  const outboundEdges = await canvas.getEdgesOfParent(nodeId);
  const blockingChildIds = outboundEdges
    .filter((e) => e.edgeKind === 'branch' && e.inheritedUntilSequence !== null && e.inheritedUntilSequence >= fromSequence)
    .map((e) => e.childNodeId);
  if (blockingChildIds.length > 0) {
    throw new MessageReferencedByBranchError(blockingChildIds);
  }

  const p = getPersistence();
  const all = await p.list<Message>('messages', (m) => m.nodeId === nodeId && m.sequence >= fromSequence);
  // 守卫已在上方串行完成，删除操作之间无依赖关系，并行执行降低延迟
  await Promise.all(all.map((m) => p.delete('messages', m.id)));
  return all.length;
}

// === 分支动作 ===
// 80px：折叠态节点高度上限约 60px，留 20px 视觉间距，使多次分支产生的子节点不互相遮挡
const BRANCH_Y_OFFSET = 80;

export async function branchNode(params: {
  parentNodeId: string;
  fromMessageId: string;
  // 可选位置覆盖：前端在视口外父节点上发起分支时传入"视口可见区内的空位"，
  // 避免子节点继续累加到屏外造成"看不见"。未提供则回退到 parent.X+440 / Y+sibling*80 的偏移算法。
  positionOverride?: { x: number; y: number } | null;
}): Promise<{ node: Node; edge: Edge }> {
  const parent = await canvas.getNode(params.parentNodeId);
  if (!parent) throw new Error(`parent node not found: ${params.parentNodeId}`);

  // 找到 fromMessageId 所在的 sequence
  const messages = await getMessagesOfNode(params.parentNodeId);
  const fromMsg = messages.find((m) => m.id === params.fromMessageId);
  if (!fromMsg) {
    throw new Error(`fromMessageId not found in parent: ${params.fromMessageId}`);
  }

  let positionX: number;
  let positionY: number;
  if (params.positionOverride) {
    positionX = params.positionOverride.x;
    positionY = params.positionOverride.y;
  } else {
    // 已有兄弟分支数决定 Y 错开量（第 N+1 个子节点落在父节点下方 N * BRANCH_Y_OFFSET 处）
    const siblingBranchCount = (await canvas.getEdgesOfParent(params.parentNodeId)).filter(
      (e) => e.edgeKind === 'branch',
    ).length;
    positionX = parent.positionX + 440;
    positionY = parent.positionY + siblingBranchCount * BRANCH_Y_OFFSET;
  }
  const childNode = await canvas.createNode({
    positionX,
    positionY,
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
