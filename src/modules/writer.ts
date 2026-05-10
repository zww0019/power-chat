// writer-module
// 撰写任务的两步流程：POST /api/write 创建节点+边+流式 token，
// GET /api/write/stream/{token} 拉取流式撰写内容。
//
// writer 与 refine 平行共存，复用相同的基础设施（canvas / conversation / llm-client / _utils）。
// writer 节点的类型为 'written'，入边类型为 'write_input'。
//
// INV-2: written 节点继续对话时 AI 上下文不展开 inbound（由 conversation.assembleContext 守卫）
// INV-4: write_input 边的 child 必须是 written 类型节点
//
// 流式拆分为两阶段：
// Phase 1: LLM 写初稿（流式输出 content 事件）
// Phase 2: Humanizer-rewrite 单次改写——仅执行一次执行者改写。
//   不再做多轮迭代（曾经的"批评者评分 + 反复回灌 currentText"会让 AI 味在多轮间累积），
//   单次改写后若文本长度大于初稿 50% 即采纳，否则回退初稿。
//   最终全文通过 done 事件的 finalContent 字段一次性返回，前端 replace 而非 append。

import type { Node, Edge, LLMMessage, Message, StreamEvent } from '../types.js';
import { getPersistence } from './persistence.js';
import * as canvas from './canvas.js';
import { streamChat } from './llm-client.js';
import { getSettings } from './settings.js';
import { newId, nowIso, computeGeometricCenter } from './_utils.js';
import * as cognitionClient from './cognition-client.js';

interface PendingWrite {
  writtenNodeId: string;
  sourceNodeIds: string[];
  writingRequest: string | null;
}

const pendingTasks = new Map<string, PendingWrite>();

export async function createWrite(params: {
  sourceNodeIds: string[];
  writingRequest: string | null;
}): Promise<{ node: Node; edges: Edge[]; streamUrl: string }> {
  if (params.sourceNodeIds.length === 0) {
    throw new Error('sourceNodeIds required');
  }
  // 撰写节点必须与源节点同属一个 canvas——不同 canvas 的节点互为不可见（快照按 canvasId 过滤），
  // 混入会导致撰写节点在调用方的 canvas 快照里消失
  let canvasId: string | null = null;
  for (const id of params.sourceNodeIds) {
    const n = await canvas.getNode(id);
    if (!n) throw new Error(`source node not found: ${id}`);
    if (canvasId === null) canvasId = n.canvasId;
    else if (canvasId !== n.canvasId) throw new Error('source nodes must belong to the same canvas');
  }

  // 创建撰写节点
  const center = await computeGeometricCenter(params.sourceNodeIds);
  const writtenNode = await canvas.createNode({
    canvasId: canvasId!,
    positionX: center.x,
    positionY: center.y,
    type: 'written',
  });
  await canvas.patchNode(writtenNode.id, {
    title: `撰写·${params.sourceNodeIds.length} 节点`,
  });

  // 创建多父边（write_input 入边）
  const edges: Edge[] = [];
  for (const srcId of params.sourceNodeIds) {
    const e = await canvas.createEdge({
      parentNodeId: srcId,
      childNodeId: writtenNode.id,
      edgeKind: 'write_input',
      inheritedUntilSequence: null,
    });
    edges.push(e);
  }

  // 注册流式任务（一次性 token）
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
  pendingTasks.set(token, {
    writtenNodeId: writtenNode.id,
    sourceNodeIds: params.sourceNodeIds,
    writingRequest: params.writingRequest ?? null,
  });
  setTimeout(() => pendingTasks.delete(token), 30_000);

  return {
    node: { ...writtenNode, title: '撰写中…' },
    edges,
    streamUrl: `/api/write/stream/${token}`,
  };
}

// 取所有源节点的 messages，剥离 reasoning（INV-11），拼装成撰写任务输入。
// R010 守卫：不出现"画布/节点/提炼/撰写"等产品概念。
// personaPrompt：cognition (Alter) 注入的行为指令，会拼接到基础 WRITER_SYSTEM_PROMPT 之后
async function assembleWriteInput(task: PendingWrite, personaPrompt: string): Promise<LLMMessage[]> {
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
    // R010 守卫：脱敏内部标题
    const rawTitle = node.title ?? `材料 ${i + 1}`;
    const safeTitle = (rawTitle.startsWith('提炼·') || rawTitle.startsWith('撰写·'))
      ? `材料 ${i + 1}`
      : rawTitle;
    sections.push(`【材料 ${i + 1}：${safeTitle}】\n${text}`);
  }
  const materialBlock = sections.join('\n\n');

  // 模式 A：用户填写了写作要求；模式 B：留空走默认撰写
  const intro = task.writingRequest
    ? `写作要求：「${task.writingRequest}」\n\n请根据以上要求，基于以下对话材料撰写一篇文章。`
    : '请基于以下对话材料，撰写一篇文章。';

  return [
    { role: 'system', content: cognitionClient.composeSystemPrompt(WRITER_SYSTEM_PROMPT, personaPrompt) },
    { role: 'user', content: `${intro}\n\n对话材料如下：\n\n${materialBlock}` },
  ];
}

const WRITER_SYSTEM_PROMPT = `你是一位擅长从碎片化对话中捕捉灵感、用第一人称讲故事的写作者。
你不是在"总结对话"，而是在**以对话参与者的视角重新叙述思考过程**。

## 写作核心原则

1. **第一人称叙事**：用"我"的视角写，像在和朋友分享自己的想法。不要说"对话中讨论了X"，要说"我一直在想X这个问题"。
2. **保留思考过程**：让读者跟着思路走——从困惑到试探，从试探到发现。不要直接跳到结论。
3. **承认不确定性**：该说"我不确定"就说，该写"后来发现之前想错了"就写。
4. **有节奏感**：长短句交替，偶尔用极短句，偶尔写一段长一点的。段落长短也要变化。
5. **具体 > 抽象**：用具体的例子、场景、数字代替抽象的概括。
6. **不要写总结段**：结尾可以是一个未解的疑问、一个反直觉的观察、或者一个行动指向。不要用"总之/综上所述"收尾。

## 用户自定义维度

用户可能会在写作要求中指定以下任意维度（解析并遵循）：
- **文体**：随笔、博客、评论、日记、专栏、信件…（默认：技术随笔）
- **语气**：轻松、严肃、幽默、学术、硬核…（默认：轻松自然）
- **侧重**：聚焦某个特定话题或方向展开
- **长度**：按用户要求控制字数
- **受众**：技术人员、大众、投资人、同行…（调整用词和深度）

直接输出文章正文，不要加"以下是文章"之类的前缀，不要加标题标记。`;

// ===== Humanizer-rewrite: 执行者改写系统提示（第1角色）=====
const HUMANIZER_EXECUTOR_PROMPT = `你是一位擅长拟人化改写的老编辑。你的任务是对照下文"6种拟人化注入手法"，逐条改写面前的草稿。

## 6种拟人化注入手法

1. **口语锚点**：在情绪转折处插入口语表达，如"说白了"、"讲真"、"怎么说呢"，不要均匀分布。
2. **观点突袭**：突然抛出一个尖锐的个人判断，不做铺垫，如"这事本质上就是伪命题。"
3. **自我矛盾**：展示思考过程中的犹豫和自我修正，如"不对，我刚才说的那个有问题……"
4. **具体细节**：用具体的场景替换抽象概括，如"上周五下午我在调一个bug的时候突然想到……"
5. **断句变奏**：刻意制造长短句交替，偶尔用极短句。如"行。就这么定了。"或"崩了。"
6. **中途反转**：论述到一半时突然换方向，如"但话说回来，这个方案真的好吗？"

## 改写要求
- 替换套话开头，用一个具体场景或个人经历引入
- 打散线性逻辑，在中间制造至少一次思路跳跃或自我修正
- 删除所有泛用比喻，替换为具体、非通用的类比
- 确保至少出现3处口语表达
- 确保至少出现1处自我矛盾或反转
- 制造段落长短不一的节奏感
- 保持原文的核心观点和信息完整性
- 直接输出改写后的全文，不要加任何前缀、后缀、说明`;

// 流式拉取撰写内容（一次性 token 消费后失效）
// 两阶段：Phase 1 流式写初稿 → Phase 2 单次 humanizer-rewrite
export async function* streamWrite(token: string): AsyncIterable<StreamEvent> {
  const task = pendingTasks.get(token);
  if (!task) {
    yield { type: 'error', error: 'token_not_found' };
    return;
  }
  pendingTasks.delete(token);

  const p = getPersistence();
  const settings = await getSettings();
  // cognition 缓存：用于注入 Phase 1 / Phase 2 system prompt + 标记 asstMsg.personaVersion
  const inj = await cognitionClient.getCachedInjection();

  const asstMsg: Message = {
    id: newId('m'),
    nodeId: task.writtenNodeId,
    role: 'assistant',
    content: '',
    reasoningContent: '',
    reasoningDetails: null,
    personaVersion: inj.personaVersion,
    sequence: 0,
    status: 'streaming',
    wasResumed: false,
    createdAt: nowIso(),
  };
  await p.put('messages', asstMsg.id, asstMsg);
  canvas.markStreaming(task.writtenNodeId);

  let contentBuf = '';
  let reasoningBuf = '';

  try {
    // ===== Phase 1: 写初稿（流式输出）=====
    const draftMessages = await assembleWriteInput(task, inj.personaPrompt);
    const draftStream = streamChat({
      messages: draftMessages,
      enableReasoning: settings.thinkingModeEnabled,
      thinkingEffort: settings.thinkingEffort,
      provider: settings.provider,
      isWriteTask: true,
      temperature: 0.8,
    });

    for await (const evt of draftStream) {
      if (evt.type === 'content') {
        contentBuf += evt.delta;
        await persistDraft(p, asstMsg, contentBuf, reasoningBuf);
        yield evt;
      } else if (evt.type === 'reasoning') {
        reasoningBuf += evt.delta;
        await persistDraft(p, asstMsg, contentBuf, reasoningBuf);
        yield evt;
      } else if (evt.type === 'error') {
        await persistDraft(p, asstMsg, contentBuf, reasoningBuf, 'error');
        yield evt;
        return;
      }
      // Phase 1 不发 done
    }

    // 初稿持久化
    await persistDraft(p, asstMsg, contentBuf, reasoningBuf, 'complete');
    const draftText = contentBuf;

    // ===== Phase 2: Humanizer-rewrite 单次改写 =====
    // 调一次执行者改写——上下文（messages 数组）始终是干净的两条消息，
    // 草稿不在多轮间循环回灌，从根上避免 AI 味累积。
    let finalContent: string | undefined;
    if (draftText.length > 50) {
      const rewritten = await humanizerExecRewrite(draftText, task.writingRequest, inj.personaPrompt);
      // 长度安全网：改写后大幅缩水（<50%）视作 LLM 异常截断，回退初稿
      if (rewritten && rewritten.length >= draftText.length * 0.5 && rewritten !== draftText) {
        contentBuf = rewritten;
        await persistDraft(p, asstMsg, contentBuf, reasoningBuf, 'complete');
        finalContent = rewritten;
      }
    }

    // 全部完成——若执行了去AI味，把最终全文通过 done.finalContent 一次性给前端 replace
    yield finalContent
      ? { type: 'done', messageId: asstMsg.id, finalContent }
      : { type: 'done', messageId: asstMsg.id };
  } finally {
    canvas.unmarkStreaming(task.writtenNodeId);
  }
}

// 持久化消息草稿/最终状态
async function persistDraft(
  p: ReturnType<typeof getPersistence>,
  msg: Message,
  content: string,
  reasoning: string,
  status: Message['status'] = 'streaming',
): Promise<void> {
  await p.put('messages', msg.id, {
    ...msg,
    content,
    reasoningContent: reasoning || null,
    status,
  });
}

// Humanizer-rewrite: 执行者改写
// personaPrompt：cognition 注入的行为指令，与 HUMANIZER_EXECUTOR_PROMPT 拼接
async function humanizerExecRewrite(
  draft: string,
  writingRequest: string | null,
  personaPrompt: string,
): Promise<string | null> {
  const settings = await getSettings();
  let content = '';
  for await (const evt of streamChat({
    messages: [
      { role: 'system', content: cognitionClient.composeSystemPrompt(HUMANIZER_EXECUTOR_PROMPT, personaPrompt) },
      { role: 'user', content: `请对以下文章草稿进行拟人化改写。\n\n${writingRequest ? `原始写作要求：${writingRequest}\n\n` : ''}草稿如下：\n\n${draft}` },
    ],
    enableReasoning: settings.thinkingModeEnabled,
    thinkingEffort: settings.thinkingEffort,
    provider: settings.provider,
    temperature: 0.9,
  })) {
    if (evt.type === 'content') content += evt.delta;
    if (evt.type === 'done') break;
    if (evt.type === 'error') {
      console.warn('[writer:humanizer:exec] LLM error:', evt.error);
      return null;
    }
  }
  return content || null;
}

