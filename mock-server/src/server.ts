// Stage 6: mock-server 现在是真实模块的薄壳。
// 不再有自己的业务逻辑——所有 HTTP handler 委托到 src/modules/*。
// Stage 7 切到 Electron 主进程时，把 Express 替换成 IPC 即可，模块无需修改。

import express, { Request, Response } from 'express';
import cors from 'cors';
import {
  ContextOverflowError,
  MessageReferencedByBranchError,
  NoMessagesForTitleError,
  NodeAlreadyExistsError,
  NodeNotFoundError,
  NotConfiguredError,
  StreamingNodeError,
  TitleGenerationFailedError,
} from '../../src/types.js';
import * as canvas from '../../src/modules/canvas.js';
import * as conversation from '../../src/modules/conversation.js';
import * as refine from '../../src/modules/refine.js';
import * as writer from '../../src/modules/writer.js';
import * as settings from '../../src/modules/settings.js';
import * as cognition from '../../src/modules/cognition-client.js';
import * as abortRegistry from '../../src/modules/abort-registry.js';
import * as project from '../../src/modules/project.js';
import { getPersistence } from '../../src/modules/persistence.js';
import type { StreamEvent } from '../../src/types.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = Number(process.env.PORT ?? 3001);

// === project ===
// 多项目管理：列表、创建、改名、删除。删除会级联清理 canvas + nodes + edges + messages。
app.get('/api/projects', async (_req, res) => {
  try {
    res.json(await project.listProjects());
  } catch (e: any) {
    res.status(500).json({ error: 'internal', message: e.message });
  }
});

app.post('/api/projects', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  if (!name.trim()) {
    res.status(400).json({ error: 'bad_request', message: 'name required' });
    return;
  }
  await respondCreated(res, () => project.createProject({ name }), 'internal', 500);
});

app.patch('/api/projects/:id', async (req, res) => {
  try {
    const updated = await project.updateProject(req.params.id, req.body ?? {});
    if (!updated) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: 'bad_request', message: e.message });
  }
});

app.post('/api/projects/:id/touch', async (req, res) => {
  try {
    await project.touchProject(req.params.id);
    res.status(204).end();
  } catch (e: any) {
    res.status(500).json({ error: 'internal', message: e.message });
  }
});

app.delete('/api/projects/:id', (req, res) =>
  respondDelete(res, () => project.deleteProject(req.params.id)),
);

// === canvas ===
// projectId 必填（query 参数）：通过 project.canvasId 反查真实 canvas，
// 再走 getCanvasSnapshot(canvasId) 拿严格按 canvasId 过滤的快照
app.get('/api/canvas', async (req, res) => {
  try {
    const projectId = (req.query.projectId as string | undefined) ?? '';
    if (!projectId) {
      res.status(400).json({ error: 'bad_request', message: 'projectId required' });
      return;
    }
    const proj = await project.getProject(projectId);
    if (!proj) {
      res.status(404).json({ error: 'not_found', message: `project not found: ${projectId}` });
      return;
    }
    const snapshot = await canvas.getCanvasSnapshot(proj.canvasId);
    if (!snapshot) {
      res.status(404).json({ error: 'not_found', message: 'canvas not found' });
      return;
    }
    res.json(snapshot);
  } catch (e: any) {
    res.status(500).json({ error: 'internal', message: e.message });
  }
});

// 创建节点：必须显式声明 canvasId 所属画布，由前端从已加载的 canvas snapshot 取值传入
app.post('/api/nodes', async (req, res) => {
  const { canvasId, positionX, positionY, type } = req.body ?? {};
  if (typeof canvasId !== 'string' || !canvasId) {
    res.status(400).json({ error: 'bad_request', message: 'canvasId required' });
    return;
  }
  if (typeof positionX !== 'number' || typeof positionY !== 'number') {
    res.status(400).json({ error: 'bad_request', message: 'positionX, positionY required' });
    return;
  }
  await respondCreated(res, () => canvas.createNode({ canvasId, positionX, positionY, type }), 'internal', 500);
});

app.patch('/api/nodes/:id', async (req, res) => {
  try {
    const node = await canvas.patchNode(req.params.id, req.body);
    if (!node) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(node);
  } catch (e: any) {
    res.status(400).json({ error: 'bad_request', message: e.message });
  }
});

app.delete('/api/nodes/:id', (req, res) =>
  respondDelete(res, () => canvas.deleteNode(req.params.id), (e) => {
    if (e instanceof StreamingNodeError) {
      res.status(409).json({ error: 'streaming', message: e.message });
      return true;
    }
    return false;
  }),
);

app.delete('/api/edges/:id', (req, res) =>
  respondDelete(res, () => canvas.deleteEdge(req.params.id)),
);

// 撤销恢复：前端 undo 栈持有完整快照（node + messages + edges），调用此端点事务写回。
// 边写入不过滤悬空（对端节点不存在的边照常入库），见 canvas.ts::restoreNode 的注释。
app.post('/api/nodes/restore', async (req, res) => {
  const { node, messages, edges } = req.body ?? {};
  if (!node || !Array.isArray(messages) || !Array.isArray(edges)) {
    res.status(400).json({ error: 'bad_request', message: 'node, messages[], edges[] required' });
    return;
  }
  try {
    await canvas.restoreNode({ node, messages, edges });
    res.status(204).end();
  } catch (e: any) {
    if (e instanceof NodeAlreadyExistsError) {
      res.status(409).json({ error: 'already_exists', message: e.message });
      return;
    }
    res.status(500).json({ error: 'internal', message: e.message });
  }
});

// === agent 中断（M5 / 决策 25）===
// 让前端中断按钮 + nodeActions 内的 §7.1 同节点自动中断都通过此端点
app.post('/api/nodes/:id/messages/abort', (req, res) => {
  const ok = abortRegistry.abortStream(req.params.id, 'user_aborted');
  if (!ok) {
    res.status(404).json({ error: 'not_streaming', message: 'no active stream for node' });
    return;
  }
  res.status(204).end();
});

// 截断式删除消息（用户编辑触发）。
// fromSequence 通过 query 传：DELETE /api/nodes/:id/messages?fromSequence=N
// 守卫错误映射：StreamingNodeError → 409 streaming；MessageReferencedByBranchError → 409 branch_referenced
app.delete('/api/nodes/:id/messages', async (req, res) => {
  const fromSequence = Number(req.query.fromSequence);
  if (!Number.isInteger(fromSequence) || fromSequence < 0) {
    res.status(400).json({ error: 'bad_request', message: 'fromSequence (non-negative integer) required' });
    return;
  }
  try {
    const deleted = await conversation.truncateMessages(req.params.id, fromSequence);
    res.status(200).json({ deleted });
  } catch (e: any) {
    if (e instanceof StreamingNodeError) {
      res.status(409).json({ error: 'streaming', message: e.message });
      return;
    }
    if (e instanceof MessageReferencedByBranchError) {
      res.status(409).json({ error: 'branch_referenced', message: e.message, childNodeIds: e.childNodeIds });
      return;
    }
    res.status(500).json({ error: 'internal', message: e.message });
  }
});

// 用户主动触发节点标题重新生成（点击标题旁的刷新图标）。
// 错误映射：
// - NodeNotFoundError → 404 not_found
// - NoMessagesForTitleError → 400 empty_node
// - TitleGenerationFailedError / NotConfiguredError → 502 llm_failed
// 与 ipc.ts 同款映射保持两端一致（E020）
app.post('/api/nodes/:id/regenerate-title', async (req, res) => {
  try {
    const result = await conversation.regenerateNodeTitle(req.params.id);
    res.json(result);
  } catch (e: any) {
    if (e instanceof NodeNotFoundError) {
      res.status(404).json({ error: 'not_found', message: e.message });
      return;
    }
    if (e instanceof NoMessagesForTitleError) {
      res.status(400).json({ error: 'empty_node', message: e.message });
      return;
    }
    if (e instanceof NotConfiguredError) {
      res.status(502).json({ error: 'not_configured', message: 'LLM 未配置' });
      return;
    }
    if (e instanceof TitleGenerationFailedError) {
      res.status(502).json({ error: 'llm_failed', message: e.message });
      return;
    }
    res.status(502).json({ error: 'llm_failed', message: e.message ?? String(e) });
  }
});

// === conversation ===
app.post('/api/nodes/branch', async (req, res) => {
  const { parentNodeId, fromMessageId, positionOverride } = req.body;
  if (!parentNodeId || !fromMessageId) {
    res.status(400).json({ error: 'bad_request', message: 'parentNodeId, fromMessageId required' });
    return;
  }
  await respondCreated(res, () => conversation.branchNode({ parentNodeId, fromMessageId, positionOverride }));
});

app.post('/api/nodes/:id/messages', async (req, res) => {
  const { content } = req.body;
  if (!content || typeof content !== 'string') {
    res.status(400).json({ error: 'bad_request', message: 'content required' });
    return;
  }

    // 全局并发 1 守卫（决策 26 / R018）：已有节点流式中时拒绝；
  // 必须在 setupSSE 之前执行——一旦调用 setupSSE 写出响应头，HTTP 状态码就无法再改变，
  // 409 就再也发不出去了。
  // 客户端可显式 force=true 让本端点先中断旧流再启动新流（前端在跨节点切换时由用户确认后传 force）
  if (abortRegistry.isAnyStreaming()) {
    const force = req.query.force === 'true' || req.body?.force === true;
    if (!force) {
      res.status(409).json({
        error: 'streaming_busy',
        message: 'another node is currently streaming',
        streamingNodeIds: abortRegistry.getStreamingNodeIds(),
      });
      return;
    }
    // force：批量中断现有所有流（generator 在下次 signal 检查时优雅退出）
    for (const nid of abortRegistry.getStreamingNodeIds()) {
      abortRegistry.abortStream(nid, 'forced_by_new_message');
    }
  }

  setupSSE(res);

  try {
    for await (const evt of conversation.sendMessage({
      nodeId: req.params.id,
      content,
    })) {
      writeSSE(res, evt);
    }
    res.end();
  } catch (e: any) {
    if (e instanceof ContextOverflowError) {
      // M5+ D021 起前置 token 守卫已撤销，此分支为 dead-defensive 路径——
      // 保留以备未来重启守卫（real LLM API 仍会返回 context overflow，但走通用 catch）
      writeSSE(res, {
        type: 'error',
        error: `context_overflow: estimated=${e.estimatedTokens} limit=${e.modelLimit}`,
      });
      res.end();
      return;
    }
    if (e instanceof NotConfiguredError) {
      writeSSE(res, { type: 'error', error: 'not_configured' });
      res.end();
      return;
    }
    writeSSE(res, { type: 'error', error: e.message ?? String(e) });
    res.end();
  }
});

// === refine ===
app.post('/api/refine', async (req, res) => {
  const { sourceNodeIds, intentQuestion } = req.body;
  if (!Array.isArray(sourceNodeIds) || sourceNodeIds.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'sourceNodeIds required' });
    return;
  }
  await respondCreated(res, () => refine.createRefine({ sourceNodeIds, intentQuestion }));
});

app.get('/api/refine/stream/:token', async (req, res) => {
  setupSSE(res);

  for await (const evt of refine.streamRefine(req.params.token)) {
    writeSSE(res, evt);
    if (evt.type === 'error' && evt.error === 'token_not_found') {
      // token 失效不应在 SSE 里发，应是 404
      res.end();
      return;
    }
  }
  res.end();
});

// === writer ===
app.post('/api/write', async (req, res) => {
  const { sourceNodeIds, writingRequest } = req.body;
  if (!Array.isArray(sourceNodeIds) || sourceNodeIds.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'sourceNodeIds required' });
    return;
  }
  await respondCreated(res, () => writer.createWrite({ sourceNodeIds, writingRequest }));
});

app.get('/api/write/stream/:token', async (req, res) => {
  setupSSE(res);

  for await (const evt of writer.streamWrite(req.params.token)) {
    writeSSE(res, evt);
    if (evt.type === 'error' && evt.error === 'token_not_found') {
      res.end();
      return;
    }
  }
  res.end();
});

// === settings ===
app.get('/api/settings', async (_req, res) => {
  res.json(await settings.getSettingsMasked());
});

app.put('/api/settings', async (req, res) => {
  res.json(await settings.putSettings(req.body));
});

app.post('/api/settings/test', async (_req, res) => {
  const result = await settings.testConnection();
  if (!result.ok) {
    res.status(502).json({ error: 'connection_failed', message: result.error, ...result });
    return;
  }
  res.json({ ok: true, modelsAvailable: result.modelsAvailable });
});

// === Cognition (Alter HTTP 服务) 12 条转发路由 ===
// 与 electron/src/ipc.ts 的 /api/cognition/* 路由 1:1 对称（项目宪法：两端路由必须同形）
// 全部走 cognition-client 模块；服务不可达统一 502 cognition_unreachable
app.get('/api/cognition/health', async (_req, res) => {
  const r = await cognition.health();
  if (!r.ok) {
    res.status(502).json({ error: 'cognition_unreachable', message: r.error });
    return;
  }
  res.json(r);
});

app.get('/api/cognition/state', async (_req, res) => {
  const data = await cognition.getState();
  if (data === null) {
    res.status(502).json({ error: 'cognition_unreachable' });
    return;
  }
  res.json(data);
});

app.delete('/api/cognition/state', async (_req, res) => {
  const ok = await cognition.deleteState();
  if (!ok) {
    res.status(502).json({ error: 'cognition_unreachable' });
    return;
  }
  res.json({ status: 'ok' });
});

app.get('/api/cognition/summary', async (_req, res) => {
  const data = await cognition.getSummary();
  if (data === null) {
    res.status(502).json({ error: 'cognition_unreachable' });
    return;
  }
  res.json(data);
});

app.get('/api/cognition/explain', async (req, res) => {
  const ctx = (req.query.context as string | undefined) ?? 'default';
  const data = await cognition.explain(ctx);
  if (data === null) {
    res.status(502).json({ error: 'cognition_unreachable' });
    return;
  }
  res.json(data);
});

app.post('/api/cognition/forget', async (req, res) => {
  const itemId = req.body?.item_id;
  if (typeof itemId !== 'string' || !itemId) {
    res.status(400).json({ error: 'bad_request', message: 'item_id required' });
    return;
  }
  const ok = await cognition.forget(itemId);
  if (!ok) {
    res.status(502).json({ error: 'cognition_unreachable' });
    return;
  }
  res.json({ status: 'ok' });
});

app.post('/api/cognition/freeze', async (req, res) => {
  const patternId = req.body?.pattern_id;
  if (typeof patternId !== 'string' || !patternId) {
    res.status(400).json({ error: 'bad_request', message: 'pattern_id required' });
    return;
  }
  const ok = await cognition.freeze(patternId);
  if (!ok) {
    res.status(502).json({ error: 'cognition_unreachable' });
    return;
  }
  res.json({ status: 'ok' });
});

app.post('/api/cognition/unfreeze', async (req, res) => {
  const patternId = req.body?.pattern_id;
  if (typeof patternId !== 'string' || !patternId) {
    res.status(400).json({ error: 'bad_request', message: 'pattern_id required' });
    return;
  }
  const ok = await cognition.unfreeze(patternId);
  if (!ok) {
    res.status(502).json({ error: 'cognition_unreachable' });
    return;
  }
  res.json({ status: 'ok' });
});

app.get('/api/cognition/users', async (_req, res) => {
  const data = await cognition.listUsers();
  if (data === null) {
    res.status(502).json({ error: 'cognition_unreachable' });
    return;
  }
  res.json(data);
});

app.get('/api/cognition/metrics', async (_req, res) => {
  const data = await cognition.getMetrics();
  if (data === null) {
    res.status(502).json({ error: 'cognition_unreachable' });
    return;
  }
  res.json(data);
});

app.get('/api/cognition/settings', async (_req, res) => {
  const data = await cognition.getCognitionSettings();
  if (data === null) {
    res.status(502).json({ error: 'cognition_unreachable' });
    return;
  }
  res.json(data);
});

app.put('/api/cognition/settings', async (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'bad_request', message: 'body must be a non-empty object' });
    return;
  }
  const data = await cognition.putCognitionSettings(req.body);
  if (data === null) {
    res.status(502).json({ error: 'cognition_unreachable' });
    return;
  }
  res.json(data);
});

app.post('/api/cognition/replay', async (req, res) => {
  if (!Array.isArray(req.body?.conversations)) {
    res.status(400).json({ error: 'bad_request', message: 'conversations[] required' });
    return;
  }
  const data = await cognition.replay(req.body.conversations, {
    force: req.body.force,
    persist: req.body.persist,
    fromEmpty: req.body.from_empty,
  });
  if (data === null) {
    res.status(502).json({ error: 'cognition_unreachable' });
    return;
  }
  res.json(data);
});

// === 测试辅助：读取当前 abort registry 状态（仅 mock 模式开放）===
// 让测试能直接观察 server 端 streaming 节点列表，避免靠 setTimeout 估时
app.get('/api/__test__/streaming-info', (_req, res) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).end();
    return;
  }
  res.json({ streamingNodeIds: abortRegistry.getStreamingNodeIds() });
});

// === 测试辅助：读取 mockStream 最近一次入参 messages（仅 mock 模式开放）===
// 让测试能跨进程（vitest 进程 vs mock-server 进程）观察 LLM 协议层入参，
// 验证 reasoning_content 等字段是否按协议要求回传给下一轮调用
app.get('/api/__test__/last-llm-messages', async (_req, res) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).end();
    return;
  }
  const fx = await import('../../src/modules/fixtures.js');
  res.json({ messages: fx.getLastMockLLMMessages() });
});

// === 测试辅助：重置数据库 + 清 abort registry（仅 mock 模式开放）===
app.post('/api/__test__/reset', async (_req, res) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).end();
    return;
  }
  // 清 abort registry：上一个测试残留的 AbortController 必须取消，否则新测试启动时
  // 全局并发 1 守卫会误报 409 streaming_busy（每个 beforeEach 跑此端点保证测试隔离）
  abortRegistry.__resetRegistryForTest();
  await getPersistence().reset();
  res.status(204).end();
});

function writeSSE(res: Response, data: StreamEvent): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * 初始化 SSE 响应头并立即刷出（防止 Node.js 缓冲区延迟首帧）。
 * 必须在写任何 data: 帧之前调用；调用后不能再修改响应状态码。
 */
function setupSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  (res as any).flushHeaders?.();
}

/**
 * 创建资源的标准响应：成功 201 / 异常根据 errorCode 与 errorStatus 决定。
 * 默认错误为 400 bad_request（业务错误，如重复 / 不存在的 fromMessageId）；
 * 内部错误（系统级）传 errorCode='internal' + errorStatus=500
 */
async function respondCreated<T>(
  res: Response,
  fn: () => Promise<T>,
  errorCode: 'bad_request' | 'internal' = 'bad_request',
  errorStatus: 400 | 500 = 400,
): Promise<void> {
  try {
    const result = await fn();
    res.status(201).json(result);
  } catch (e: any) {
    res.status(errorStatus).json({ error: errorCode, message: e.message });
  }
}

/**
 * 删除资源的标准响应：成功 204 / 不存在 404 / 异常 500。
 * @param deleteFn 执行实际删除，返回是否真正删除了记录
 * @param onError  端点专属错误映射（如 StreamingNodeError → 409）；
 *                 返回 true 表示已写响应，respondDelete 不再处理
 */
async function respondDelete(
  res: Response,
  deleteFn: () => Promise<boolean>,
  onError?: (e: any) => boolean,
): Promise<void> {
  try {
    const deleted = await deleteFn();
    if (!deleted) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(204).end();
  } catch (e: any) {
    if (onError && onError(e)) return;
    res.status(500).json({ error: 'internal', message: e.message });
  }
}

app.listen(PORT, () => {
  console.log(`[mock-server] Stage 6: 真实模块 listening on http://localhost:${PORT}`);
  if (process.env.USE_MOCK_LLM === '1') {
    console.log(`[mock-server] LLM 调用走 mock fixture（USE_MOCK_LLM=1）`);
  }
});
