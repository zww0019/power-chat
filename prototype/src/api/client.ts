// 双适配 API 客户端：
// - Electron 环境：通过 window.powerChat IPC 桥
// - 浏览器 dev 环境：fetch + SSE（走 mock-server）
//
// Stage 6 模块层 + Stage 4 OpenAPI 契约保证两端响应一致。

import type {
  Canvas,
  Node,
  Edge,
  Message,
  Settings,
  CreateNodeRequest,
  BranchRequest,
  RefineRequest,
  StreamEvent,
} from '../types';

// === Electron 桥类型 ===
declare global {
  interface Window {
    powerChat?: {
      isElectron: true;
      request(method: string, path: string, body?: unknown): Promise<{
        status: number;
        body?: unknown;
        error?: { error: string; message?: string };
      }>;
      startStream(path: string, body?: unknown): Promise<{ streamId: string } | { error: string }>;
      onStreamEvent(streamId: string, callback: (e: StreamEvent) => void): () => void;
    };
  }
}

const isElectron = typeof window !== 'undefined' && !!window.powerChat;

async function request<T>(path: string, init?: RequestInit & { method?: string }): Promise<T> {
  const method = init?.method ?? 'GET';
  let body: unknown = undefined;
  if (init?.body) {
    body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  }

  if (isElectron && window.powerChat) {
    const result = await window.powerChat.request(method, `/api${path.startsWith('/api') ? path.slice(4) : path}`, body);
    if (result.error || result.status >= 400) {
      throw new Error(`[${result.status}] ${result.error?.message ?? result.error?.error ?? 'unknown'}`);
    }
    return result.body as T;
  }

  // 浏览器 dev：fetch
  const res = await fetch(`/api${path.startsWith('/api') ? path.slice(4) : path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[${res.status}] ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  async getCanvas(): Promise<{ canvas: Canvas; nodes: Node[]; edges: Edge[]; messages: Message[] }> {
    return request('/canvas');
  },

  async createNode(req: CreateNodeRequest): Promise<Node> {
    return request('/nodes', { method: 'POST', body: JSON.stringify(req) });
  },

  async branchNode(req: BranchRequest): Promise<{ node: Node; edge: Edge }> {
    return request('/nodes/branch', { method: 'POST', body: JSON.stringify(req) });
  },

  async deleteNode(id: string): Promise<void> {
    return request<void>(`/nodes/${id}`, { method: 'DELETE' });
  },

  async deleteEdge(id: string): Promise<void> {
    return request<void>(`/edges/${id}`, { method: 'DELETE' });
  },

  async updateNode(id: string, patch: Partial<Pick<Node, 'positionX' | 'positionY' | 'collapsed' | 'title'>>): Promise<Node> {
    return request(`/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },

  async getSettings(): Promise<Settings> {
    return request('/settings');
  },

  async putSettings(patch: Partial<Settings>): Promise<Settings> {
    return request('/settings', { method: 'PUT', body: JSON.stringify(patch) });
  },

  async testConnection(): Promise<{ ok: boolean; modelsAvailable: string[]; error?: string }> {
    if (isElectron && window.powerChat) {
      const r = await window.powerChat.request('POST', '/api/settings/test');
      if (r.status === 502) {
        return { ok: false, modelsAvailable: [], error: r.error?.message ?? 'connection_failed' };
      }
      if (r.status >= 400) {
        return { ok: false, modelsAvailable: [], error: r.error?.message ?? `HTTP ${r.status}` };
      }
      const body = r.body as { ok: boolean; modelsAvailable: string[] };
      return { ok: body.ok, modelsAvailable: body.modelsAvailable };
    }
    const res = await fetch('/api/settings/test', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, modelsAvailable: [], error: body.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, modelsAvailable: body.modelsAvailable ?? [] };
  },

  async refine(req: RefineRequest): Promise<{ node: Node; edges: Edge[]; streamUrl: string }> {
    return request('/refine', { method: 'POST', body: JSON.stringify(req) });
  },

  async streamMessage(
    nodeId: string,
    content: string,
    onEvent: (e: StreamEvent) => void,
    opts?: { force?: boolean },
  ): Promise<void> {
    const path = `/api/nodes/${nodeId}/messages${opts?.force ? '?force=true' : ''}`;
    if (isElectron && window.powerChat) {
      await runStream(path, { content }, onEvent);
      return;
    }
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { streamingNodeIds?: string[] };
      onEvent({ type: 'error', error: `streaming_busy:${(body.streamingNodeIds ?? []).join(',')}` });
      return;
    }
    if (!res.ok || !res.body) {
      onEvent({ type: 'error', error: `HTTP ${res.status}` });
      return;
    }
    await consumeSSE(res.body, onEvent);
  },

  // 截断式删除消息：删除 nodeId 节点中 sequence ≥ fromSequence 的所有 messages。
  // 用户编辑用户消息时调用——后续 sendMessage 会用编辑后内容追加为新一轮。
  // 守卫错误：409 streaming（节点流式中）/ 409 branch_referenced（消息被分支引用）
  async truncateMessages(nodeId: string, fromSequence: number): Promise<{ deleted: number }> {
    return request(`/nodes/${nodeId}/messages?fromSequence=${fromSequence}`, { method: 'DELETE' });
  },

  async abortStream(nodeId: string): Promise<boolean> {
    if (isElectron && window.powerChat) {
      const r = await window.powerChat.request('POST', `/api/nodes/${nodeId}/messages/abort`);
      return r.status === 204;
    }
    const res = await fetch(`/api/nodes/${nodeId}/messages/abort`, { method: 'POST' });
    return res.status === 204;
  },

  async streamRefine(streamUrl: string, onEvent: (e: StreamEvent) => void): Promise<void> {
    if (isElectron && window.powerChat) {
      await runStream(streamUrl, undefined, onEvent);
      return;
    }
    const res = await fetch(streamUrl);
    if (!res.ok || !res.body) {
      onEvent({ type: 'error', error: `HTTP ${res.status}` });
      return;
    }
    await consumeSSE(res.body, onEvent);
  },
};

// 通过 IPC 跑流式：startStream → 监听 stream:event → 完成时 unsubscribe
async function runStream(path: string, body: unknown, onEvent: (e: StreamEvent) => void): Promise<void> {
  if (!window.powerChat) return;
  const start = await window.powerChat.startStream(path, body);
  if ('error' in start) {
    onEvent({ type: 'error', error: start.error });
    return;
  }
  return new Promise<void>((resolve) => {
    const unsubscribe = window.powerChat!.onStreamEvent(start.streamId, (evt) => {
      onEvent(evt);
      if (evt.type === 'done' || evt.type === 'error') {
        unsubscribe();
        resolve();
      }
    });
  });
}

async function consumeSSE(body: ReadableStream<Uint8Array>, onEvent: (e: StreamEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const evt of events) {
      const dataLine = evt.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const json = dataLine.slice(6).trim();
      if (!json) continue;
      try {
        onEvent(JSON.parse(json) as StreamEvent);
      } catch (e) {
        console.warn('SSE parse error', e);
      }
    }
  }
}
