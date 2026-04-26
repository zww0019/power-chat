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
import * as canvas from '../../src/modules/canvas.js';
import * as conversation from '../../src/modules/conversation.js';
import * as refine from '../../src/modules/refine.js';
import * as settings from '../../src/modules/settings.js';
import { getPersistence } from '../../src/modules/persistence.js';
import {
  ContextOverflowError,
  NotConfiguredError,
  StreamingNodeError,
  type StreamEvent,
} from '../../src/types.js';

interface RpcResult {
  status: number;
  body?: unknown;
  error?: { error: string; message?: string };
}

type RouteContext = { match: RegExpMatchArray | null; body: any };
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
  {
    method: 'GET',
    pattern: '/api/canvas',
    handler: async () => buildSuccess(200, await canvas.getCanvasSnapshot()),
  },
  {
    method: 'POST',
    pattern: '/api/nodes',
    handler: async ({ body }) => {
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
];

async function dispatchRpc(method: string, path: string, body: any): Promise<RpcResult> {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.pattern === 'string') {
      if (route.pattern !== path) continue;
      return route.handler({ match: null, body });
    }
    const match = path.match(route.pattern);
    if (!match) continue;
    return route.handler({ match, body });
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

    // GET /api/refine/stream/:token（HTTP 侧是 GET，IPC 侧统一走 stream-start，path 原样透传）
  const streamMatch = path.match(/^\/api\/refine\/stream\/([^/]+)$/);
  if (streamMatch) {
    return wrapStream(refine.streamRefine(streamMatch[1]!));
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
