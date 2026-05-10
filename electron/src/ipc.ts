// IPC handlers - Electron 主进程版的 mock-server。
// 调用相同的 src/modules/*，所以 INV 守卫和业务逻辑完全一致。
//
// IPC 协议设计：
// - 普通 RPC：renderer 调 'rpc'(method, path, body) → 返回 {status, body}
// - 流式：renderer 调 'stream-start'(path, body) → 返回 streamId
//         主进程通过 webContents.send(`stream-${id}`, event) 推送
//         renderer 监听该 channel
//
// 路由分发：用 routes 数组承载所有 RPC 端点，dispatchRpc 只做匹配 + 委派；
// 每条端点的输入校验、错误映射都封在自己的 handler 里，便于增删与单元测试。

import type { IpcMain, WebContents } from 'electron';
import { shell } from 'electron';
import * as canvas from '../../src/modules/canvas.js';
import * as conversation from '../../src/modules/conversation.js';
import * as refine from '../../src/modules/refine.js';
import * as writer from '../../src/modules/writer.js';
import * as settings from '../../src/modules/settings.js';
import * as cognition from '../../src/modules/cognition-client.js';
import * as abortRegistry from '../../src/modules/abort-registry.js';
import * as project from '../../src/modules/project.js';
import { getPersistence } from '../../src/modules/persistence.js';
import {
  ContextOverflowError,
  MessageReferencedByBranchError,
  NoMessagesForTitleError,
  NodeAlreadyExistsError,
  NodeNotFoundError,
  NotConfiguredError,
  StreamingNodeError,
  TitleGenerationFailedError,
  type StreamEvent,
} from '../../src/types.js';

interface RpcResult {
  status: number;
  body?: unknown;
  error?: { error: string; message?: string };
}

type RouteContext = { match: RegExpMatchArray | null; body: any; query: URLSearchParams };
type RouteHandler = (ctx: RouteContext) => Promise<RpcResult>;

interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pattern: string | RegExp;
  handler: RouteHandler;
}

export function registerIpcHandlers(ipcMain: IpcMain, getWebContents: () => WebContents | null): void {
  ipcMain.handle('rpc', async (_evt, method: string, path: string, body: unknown): Promise<RpcResult> => {
    try {
      return await dispatchRpc(method, path, body);
    } catch (e: any) {
      console.error('[ipc] rpc error', e);
      return { status: 500, error: { error: 'internal', message: e.message ?? String(e) } };
    }
  });

  // 渲染进程通过此 IPC 让主进程在系统默认浏览器打开外链——
  // cognition 控制台（http://localhost:8000/）按钮等场景使用。
  // 此处正则守卫仅允许 http(s) scheme，非 http(s) URL 在到达 shell.openExternal 之前就已拒绝
  ipcMain.handle('shell-open-external', async (_evt, url: unknown): Promise<{ ok: boolean; error?: string }> => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'only http(s) URLs allowed' };
    }
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('stream-start', async (_evt, path: string, body: unknown): Promise<{ streamId: string } | { error: string }> => {
    const streamId = `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const wc = getWebContents();
    if (!wc) return { error: 'no_webcontents' };

    // 异步启动流式任务，不阻塞 invoke
    void (async () => {
      try {
        const events = await openStream(path, body);
        for await (const evt of events) {
          if (wc.isDestroyed()) return;
          wc.send(`stream-${streamId}`, evt);
        }
      } catch (e: any) {
        if (!wc.isDestroyed()) {
          const errEvt: StreamEvent = { type: 'error', error: e.message ?? String(e) };
          wc.send(`stream-${streamId}`, errEvt);
        }
      }
    })();

    return { streamId };
  });
}

/** 构造成功 RpcResult；204 时 body 可省略 */
const buildSuccess = (status: number, body?: unknown): RpcResult => ({ status, body });
/** 构造失败 RpcResult；error 为错误码，message 为人类可读说明 */
const buildFailure = (status: number, error: string, message?: string): RpcResult => ({
  status,
  error: { error, ...(message ? { message } : {}) },
});

const routes: Route[] = [
  // === project ===
  // 多项目管理：列表、创建、改名、touch（更新 lastOpenedAt）、删除（级联）
  {
    method: 'GET',
    pattern: '/api/projects',
    handler: async () => buildSuccess(200, await project.listProjects()),
  },
  {
    method: 'POST',
    pattern: '/api/projects',
    handler: async ({ body }) => {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!name.trim()) return buildFailure(400, 'bad_request', 'name required');
      return buildSuccess(201, await project.createProject({ name }));
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/projects\/([^/]+)$/,
    handler: async ({ match, body }) => {
      try {
        const updated = await project.updateProject(match![1]!, body ?? {});
        if (!updated) return buildFailure(404, 'not_found');
        return buildSuccess(200, updated);
      } catch (e: any) {
        return buildFailure(400, 'bad_request', e.message);
      }
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/([^/]+)\/touch$/,
    handler: async ({ match }) => {
      await project.touchProject(match![1]!);
      return buildSuccess(204);
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/projects\/([^/]+)$/,
    handler: async ({ match }) => {
      const deleted = await project.deleteProject(match![1]!);
      if (!deleted) return buildFailure(404, 'not_found');
      return buildSuccess(204);
    },
  },
  // === canvas ===
  // projectId 必填（query 参数）：经 project.canvasId 反查真实 canvas，
  // 再走 getCanvasSnapshot(canvasId) 取严格按 canvasId 过滤的快照
  {
    method: 'GET',
    pattern: '/api/canvas',
    handler: async ({ query }) => {
      const projectId = query.get('projectId') ?? '';
      if (!projectId) return buildFailure(400, 'bad_request', 'projectId required');
      const proj = await project.getProject(projectId);
      if (!proj) return buildFailure(404, 'not_found', `project not found: ${projectId}`);
      const snapshot = await canvas.getCanvasSnapshot(proj.canvasId);
      if (!snapshot) return buildFailure(404, 'not_found', 'canvas not found');
      return buildSuccess(200, snapshot);
    },
  },
  // 创建节点：必须显式声明 canvasId（前端从已加载的 canvas snapshot 取 id 透传）
  {
    method: 'POST',
    pattern: '/api/nodes',
    handler: async ({ body }) => {
      if (typeof body?.canvasId !== 'string' || !body.canvasId) {
        return buildFailure(400, 'bad_request', 'canvasId required');
      }
      if (typeof body?.positionX !== 'number' || typeof body?.positionY !== 'number') {
        return buildFailure(400, 'bad_request', 'positionX, positionY required');
      }
      return buildSuccess(201, await canvas.createNode(body));
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/nodes\/([^/]+)$/,
    handler: async ({ match, body }) => {
      try {
        const node = await canvas.patchNode(match![1]!, body ?? {});
        if (!node) return buildFailure(404, 'not_found');
        return buildSuccess(200, node);
      } catch (e: any) {
        return buildFailure(400, 'bad_request', e.message);
      }
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/nodes\/([^/]+)$/,
    handler: async ({ match }) => {
      try {
        const deleted = await canvas.deleteNode(match![1]!);
        if (!deleted) return buildFailure(404, 'not_found');
        return buildSuccess(204);
      } catch (e: any) {
        if (e instanceof StreamingNodeError) {
          return buildFailure(409, 'streaming', e.message);
        }
        throw e;
      }
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/edges\/([^/]+)$/,
    handler: async ({ match }) => {
      const deleted = await canvas.deleteEdge(match![1]!);
      if (!deleted) return buildFailure(404, 'not_found');
      return buildSuccess(204);
    },
  },
  // 撤销恢复：与 mock-server 路由语义对齐，409 表 id 已存在。
  // 边写入不过滤悬空——见 src/modules/canvas.ts::restoreNode 注释。
  {
    method: 'POST',
    pattern: '/api/nodes/restore',
    handler: async ({ body }) => {
      if (!body?.node || !Array.isArray(body?.messages) || !Array.isArray(body?.edges)) {
        return buildFailure(400, 'bad_request', 'node, messages[], edges[] required');
      }
      try {
        await canvas.restoreNode(body);
        return buildSuccess(204);
      } catch (e: any) {
        if (e instanceof NodeAlreadyExistsError) return buildFailure(409, 'already_exists', e.message);
        throw e;
      }
    },
  },
  // 用户编辑消息时触发，删除 sequence ≥ fromSequence 的消息，为新一轮回复腾位。
  // 错误映射顺序与 mock-server/server.ts 完全对齐，确保两条路径（HTTP / IPC）
  // 对同一错误类型抛出相同的 code，避免 performEditMessage 的 includes 检测在
  // Electron 环境下漏判 streaming / branch_referenced。
  {
    method: 'DELETE',
    pattern: /^\/api\/nodes\/([^/]+)\/messages$/,
    handler: async ({ match, query }) => {
      const fromSequence = Number(query.get('fromSequence'));
      if (!Number.isInteger(fromSequence) || fromSequence < 0) {
        return buildFailure(400, 'bad_request', 'fromSequence (non-negative integer) required');
      }
      try {
        const deleted = await conversation.truncateMessages(match![1]!, fromSequence);
        return buildSuccess(200, { deleted });
      } catch (e: any) {
        if (e instanceof StreamingNodeError) return buildFailure(409, 'streaming', e.message);
        if (e instanceof MessageReferencedByBranchError) {
          return { status: 409, error: { error: 'branch_referenced', message: e.message }, body: { childNodeIds: e.childNodeIds } };
        }
        throw e;
      }
    },
  },
  {
    method: 'POST',
    pattern: '/api/nodes/branch',
    handler: async ({ body }) => {
      if (!body?.parentNodeId || !body?.fromMessageId) {
        return buildFailure(400, 'bad_request', 'parentNodeId, fromMessageId required');
      }
      try {
        return buildSuccess(201, await conversation.branchNode(body));
      } catch (e: any) {
        return buildFailure(400, 'bad_request', e.message);
      }
    },
  },
  // 用户主动触发节点标题重新生成（错误映射与 mock-server 严格对齐，E020）
  {
    method: 'POST',
    pattern: /^\/api\/nodes\/([^/]+)\/regenerate-title$/,
    handler: async ({ match }) => {
      try {
        return buildSuccess(200, await conversation.regenerateNodeTitle(match![1]!));
      } catch (e: any) {
        if (e instanceof NodeNotFoundError) return buildFailure(404, 'not_found', e.message);
        if (e instanceof NoMessagesForTitleError) return buildFailure(400, 'empty_node', e.message);
        if (e instanceof NotConfiguredError) return buildFailure(502, 'not_configured', 'LLM 未配置');
        if (e instanceof TitleGenerationFailedError) return buildFailure(502, 'llm_failed', e.message);
        return buildFailure(502, 'llm_failed', e.message ?? String(e));
      }
    },
  },
  {
    method: 'POST',
    pattern: '/api/refine',
    handler: async ({ body }) => {
      if (!Array.isArray(body?.sourceNodeIds) || body.sourceNodeIds.length === 0) {
        return buildFailure(400, 'bad_request', 'sourceNodeIds required');
      }
      try {
        return buildSuccess(201, await refine.createRefine(body));
      } catch (e: any) {
        return buildFailure(400, 'bad_request', e.message);
      }
    },
  },
  {
    method: 'POST',
    pattern: '/api/write',
    handler: async ({ body }) => {
      if (!Array.isArray(body?.sourceNodeIds) || body.sourceNodeIds.length === 0) {
        return buildFailure(400, 'bad_request', 'sourceNodeIds required');
      }
      try {
        return buildSuccess(201, await writer.createWrite(body));
      } catch (e: any) {
        return buildFailure(400, 'bad_request', e.message);
      }
    },
  },
  // agent 中断（M5 / 决策 25）：与 mock-server:100 行为对齐——
  // 成功取消返 204，节点未在流式中返 404 not_streaming
  {
    method: 'POST',
    pattern: /^\/api\/nodes\/([^/]+)\/messages\/abort$/,
    handler: async ({ match }) => {
      const ok = abortRegistry.abortStream(match![1]!, 'user_aborted');
      if (!ok) return buildFailure(404, 'not_streaming', 'no active stream for node');
      return buildSuccess(204);
    },
  },
  {
    method: 'GET',
    pattern: '/api/settings',
    handler: async () => buildSuccess(200, await settings.getSettingsMasked()),
  },
  {
    method: 'PUT',
    pattern: '/api/settings',
    handler: async ({ body }) => buildSuccess(200, await settings.putSettings(body ?? {})),
  },
  {
    method: 'POST',
    pattern: '/api/settings/test',
    handler: async () => {
      const result = await settings.testConnection();
      if (!result.ok) {
        return buildFailure(502, 'connection_failed', result.error);
      }
      return buildSuccess(200, { ok: true, modelsAvailable: result.modelsAvailable });
    },
  },
  {
    method: 'POST',
    pattern: '/api/__test__/reset',
    handler: async () => {
      await getPersistence().reset();
      return buildSuccess(204);
    },
  },
  // === Cognition (Alter HTTP 服务) 12 条转发路由 ===
  // 全部走 cognition-client 模块；服务不可达统一映射为 502 cognition_unreachable，
  // 前端按降级 UI 处理（保留缓存继续主对话 + 红角标提示）
  {
    method: 'GET',
    pattern: '/api/cognition/health',
    handler: async () => {
      const r = await cognition.health();
      return r.ok ? buildSuccess(200, r) : buildFailure(502, 'cognition_unreachable', r.error);
    },
  },
  {
    method: 'GET',
    pattern: '/api/cognition/state',
    handler: async () => {
      const data = await cognition.getState();
      if (data === null) return buildFailure(502, 'cognition_unreachable');
      return buildSuccess(200, data);
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/cognition/state',
    handler: async () => {
      const ok = await cognition.deleteState();
      return ok ? buildSuccess(200, { status: 'ok' }) : buildFailure(502, 'cognition_unreachable');
    },
  },
  {
    method: 'GET',
    pattern: '/api/cognition/summary',
    handler: async () => {
      const data = await cognition.getSummary();
      if (data === null) return buildFailure(502, 'cognition_unreachable');
      return buildSuccess(200, data);
    },
  },
  {
    method: 'GET',
    pattern: '/api/cognition/explain',
    handler: async ({ query }) => {
      const ctx = query.get('context') ?? 'default';
      const data = await cognition.explain(ctx);
      if (data === null) return buildFailure(502, 'cognition_unreachable');
      return buildSuccess(200, data);
    },
  },
  {
    method: 'POST',
    pattern: '/api/cognition/forget',
    handler: async ({ body }) => {
      if (typeof body?.item_id !== 'string' || !body.item_id) {
        return buildFailure(400, 'bad_request', 'item_id required');
      }
      const ok = await cognition.forget(body.item_id);
      return ok ? buildSuccess(200, { status: 'ok' }) : buildFailure(502, 'cognition_unreachable');
    },
  },
  {
    method: 'POST',
    pattern: '/api/cognition/freeze',
    handler: async ({ body }) => {
      if (typeof body?.pattern_id !== 'string' || !body.pattern_id) {
        return buildFailure(400, 'bad_request', 'pattern_id required');
      }
      const ok = await cognition.freeze(body.pattern_id);
      return ok ? buildSuccess(200, { status: 'ok' }) : buildFailure(502, 'cognition_unreachable');
    },
  },
  {
    method: 'POST',
    pattern: '/api/cognition/unfreeze',
    handler: async ({ body }) => {
      if (typeof body?.pattern_id !== 'string' || !body.pattern_id) {
        return buildFailure(400, 'bad_request', 'pattern_id required');
      }
      const ok = await cognition.unfreeze(body.pattern_id);
      return ok ? buildSuccess(200, { status: 'ok' }) : buildFailure(502, 'cognition_unreachable');
    },
  },
  {
    method: 'GET',
    pattern: '/api/cognition/users',
    handler: async () => {
      const data = await cognition.listUsers();
      if (data === null) return buildFailure(502, 'cognition_unreachable');
      return buildSuccess(200, data);
    },
  },
  {
    method: 'GET',
    pattern: '/api/cognition/metrics',
    handler: async () => {
      const data = await cognition.getMetrics();
      if (data === null) return buildFailure(502, 'cognition_unreachable');
      return buildSuccess(200, data);
    },
  },
  {
    method: 'GET',
    pattern: '/api/cognition/settings',
    handler: async () => {
      const data = await cognition.getCognitionSettings();
      if (data === null) return buildFailure(502, 'cognition_unreachable');
      return buildSuccess(200, data);
    },
  },
  {
    method: 'PUT',
    pattern: '/api/cognition/settings',
    handler: async ({ body }) => {
      if (!body || typeof body !== 'object') {
        return buildFailure(400, 'bad_request', 'body must be a non-empty object');
      }
      const data = await cognition.putCognitionSettings(body);
      if (data === null) return buildFailure(502, 'cognition_unreachable');
      return buildSuccess(200, data);
    },
  },
  {
    method: 'POST',
    pattern: '/api/cognition/replay',
    handler: async ({ body }) => {
      if (!Array.isArray(body?.conversations)) {
        return buildFailure(400, 'bad_request', 'conversations[] required');
      }
      const data = await cognition.replay(body.conversations, {
        force: body.force,
        persist: body.persist,
        fromEmpty: body.from_empty,
      });
      if (data === null) return buildFailure(502, 'cognition_unreachable');
      return buildSuccess(200, data);
    },
  },
];

async function dispatchRpc(method: string, path: string, body: any): Promise<RpcResult> {
  // 必须先分离 pathname 再做正则匹配：路由模式末尾有 $ 锚点，
  // 若直接匹配带 ?fromSequence=0 的完整 path，$ 无法匹配到末尾，导致 404。
  // query 透传给 handler，既有路由不使用 query，对它们无影响。
  // URL 构造器要求绝对 URL，用 'http://x' 作为无业务意义的占位 base
  const url = new URL(path, 'http://x');
  const pathname = url.pathname;
  const query = url.searchParams;
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.pattern === 'string') {
      if (route.pattern !== pathname) continue;
      return route.handler({ match: null, body, query });
    }
    const match = pathname.match(route.pattern);
    if (!match) continue;
    return route.handler({ match, body, query });
  }
  return buildFailure(404, 'not_found', `No route for ${method} ${path}`);
}

async function openStream(path: string, body: any): Promise<AsyncIterable<StreamEvent>> {
  // POST /api/nodes/:id/messages
  const msgMatch = path.match(/^\/api\/nodes\/([^/]+)\/messages$/);
  if (msgMatch) {
    if (!body?.content || typeof body.content !== 'string') {
      return errorOnce('content required');
    }
    return wrapStream(conversation.sendMessage({ nodeId: msgMatch[1]!, content: body.content }));
  }

  // /api/refine/stream/:token（IPC 侧统一走 stream-start，与 HTTP GET 语义等价，path 原样透传）
  const streamMatch = path.match(/^\/api\/refine\/stream\/([^/]+)$/);
  if (streamMatch) {
    return wrapStream(refine.streamRefine(streamMatch[1]!));
  }

  // /api/write/stream/:token（与 refine 同构）
  const writeStreamMatch = path.match(/^\/api\/write\/stream\/([^/]+)$/);
  if (writeStreamMatch) {
    return wrapStream(writer.streamWrite(writeStreamMatch[1]!));
  }

  return errorOnce(`No stream route for ${path}`);
}

async function* wrapStream(iter: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
  try {
    for await (const evt of iter) yield evt;
  } catch (e: any) {
    if (e instanceof ContextOverflowError) {
      yield { type: 'error', error: `context_overflow: ${e.estimatedTokens}/${e.modelLimit}` };
    } else if (e instanceof NotConfiguredError) {
      yield { type: 'error', error: 'not_configured' };
    } else {
      yield { type: 'error', error: e.message ?? String(e) };
    }
  }
}

async function* errorOnce(msg: string): AsyncIterable<StreamEvent> {
  yield { type: 'error', error: msg };
}
