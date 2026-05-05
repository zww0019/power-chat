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
// Phase 2: Humanizer-rewrite 三角迭代——执行者改写 → 批评者检测 → 裁判决策（最多 3 轮）

import type { Node, Edge, LLMMessage, Message, StreamEvent } from '../types.js';
import { getPersistence } from './persistence.js';
import * as canvas from './canvas.js';
import { streamChat } from './llm-client.js';
import { getSettings } from './settings.js';
import { newId, nowIso, computeGeometricCenter } from './_utils.js';

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
  for (const id of params.sourceNodeIds) {
    const n = await canvas.getNode(id);
    if (!n) throw new Error(`source node not found: ${id}`);
  }

  // 创建撰写节点
  const center = await computeGeometricCenter(params.sourceNodeIds);
  const writtenNode = await canvas.createNode({
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
async function assembleWriteInput(task: PendingWrite): Promise<LLMMessage[]> {
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
    { role: 'system', content: WRITER_SYSTEM_PROMPT },
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

// ===== Humanizer-rewrite: 批评者检测系统提示（第2角色）=====
const HUMANIZER_CRITIC_PROMPT = `你是一位严格的文本审查员。你的任务是对照以下"12种AI高危特征检测清单"，逐条审查面前的文章，并给出评分。

## 12种AI高危特征检测清单

1. 套话开头：以"在当今…时代"、"随着…的发展"、"众所周知"等万能句式开头
2. 情感中性：全文语气平淡，没有明确的个人好恶、惊讶、困惑、兴奋等情绪波动
3. 过度连接词：大量使用"值得注意的是"、"不可否认"、"与此同时"、"此外"、"总而言之"
4. 线性逻辑：严格的"提出问题→分析→结论"三段式，没有思路跳跃或中途反转
5. 泛用比喻：使用"双刃剑"、"冰山一角"、"一把钥匙"等烂大街的隐喻
6. 段落等长：每段字数高度接近，像被格式化过
7. 首句雷同：多个段落以相同句式开头
8. 万能总结：以"总之"、"综上所述"、"总的来说"作为结尾段开头
9. 缺乏具体细节：只有抽象概括，没有具体的数字、场景、人物、时间点
10. 过度平衡：每提一个优点就紧跟一个缺点，刻意保持"客观中立"
11. 解释性破折号：频繁使用"——也就是说"这种结构来解释概念
12. 无个人判断：全文没有出现"我觉得"、"我猜"、"说实话"等主观立场词

## 审查格式要求

请逐条对照检测，输出格式如下：

1. 套话开头 ✅ 或 ❌（简述理由）
2. 情感中性 ✅ 或 ❌（简述理由）
...
12. 无个人判断 ✅ 或 ❌（简述理由）

综合评分：X/10

注意：✅=通过（不含该特征），❌=命中（含该特征）。≥8分视为通过审查。`;

// 流式拉取撰写内容（一次性 token 消费后失效）
// 两阶段：Phase 1 流式写初稿 → Phase 2 三角迭代 humanizer-rewrite
export async function* streamWrite(token: string): AsyncIterable<StreamEvent> {
  const task = pendingTasks.get(token);
  if (!task) {
    yield { type: 'error', error: 'token_not_found' };
    return;
  }
  pendingTasks.delete(token);

  const p = getPersistence();
  const settings = await getSettings();

  const asstMsg: Message = {
    id: newId('m'),
    nodeId: task.writtenNodeId,
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
  canvas.markStreaming(task.writtenNodeId);

  let contentBuf = '';
  let reasoningBuf = '';

  try {
    // ===== Phase 1: 写初稿（流式输出）=====
    const draftMessages = await assembleWriteInput(task);
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

    // ===== Phase 2: Humanizer-rewrite 三角迭代 =====
    if (draftText.length > 50) {
      yield { type: 'rewrite_round', round: 0, phase: 'start' };

      let currentText = draftText;
      let finalScore = 0;

      for (let round = 1; round <= 3; round++) {
        // Step 2a: 执行者改写
        yield { type: 'rewrite_round', round, phase: 'executing' };
        const rewritten = await humanizerExecRewrite(currentText, task.writingRequest);
        if (!rewritten || rewritten.length < currentText.length * 0.5) {
          // 改写失败或大幅缩水，保留当前文本，终止迭代
          break;
        }
        currentText = rewritten;

        // Step 2b: 批评者检测
        yield { type: 'rewrite_round', round, phase: 'evaluating' };
        finalScore = await humanizerCriticEvaluate(currentText);
        yield { type: 'rewrite_round', round, phase: 'judging', score: finalScore };

        // Step 2c: 裁判决策
        if (finalScore >= 8) break;
      }

      // 最终文章覆盖 content
      if (currentText !== draftText) {
        contentBuf = currentText;
        await persistDraft(p, asstMsg, contentBuf, reasoningBuf, 'complete');
        yield { type: 'content', delta: currentText };
      }
    }

    // 全部完成
    yield { type: 'done', messageId: asstMsg.id };
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
async function humanizerExecRewrite(
  draft: string,
  writingRequest: string | null,
): Promise<string | null> {
  const settings = await getSettings();
  let content = '';
  for await (const evt of streamChat({
    messages: [
      { role: 'system', content: HUMANIZER_EXECUTOR_PROMPT },
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

// Humanizer-rewrite: 批评者检测，返回 0-10 评分
async function humanizerCriticEvaluate(text: string): Promise<number> {
  const settings = await getSettings();
  let content = '';
  for await (const evt of streamChat({
    messages: [
      { role: 'system', content: HUMANIZER_CRITIC_PROMPT },
      { role: 'user', content: `请审查以下文章，逐条对照12种AI高危特征检测清单，给出评分。\n\n文章：\n\n${text}` },
    ],
    enableReasoning: false,
    temperature: 0.3,
    provider: settings.provider,
  })) {
    if (evt.type === 'content') content += evt.delta;
    if (evt.type === 'done') break;
    if (evt.type === 'error') return 8; // 兜底通过
  }
  // 提取分数
  const scoreMatch = content.match(/综合评分[：:]\\s*(\\d+)/);
  if (scoreMatch) {
    const s = parseInt(scoreMatch[1]!, 10);
    return Math.min(10, Math.max(0, s));
  }
  const fallback = content.match(/\b([0-9]|10)\b/);
  return fallback ? parseInt(fallback[1]!, 10) : 8;
}
