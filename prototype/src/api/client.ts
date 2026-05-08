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
  WriteRequest,
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

// init.body 接受对象或字符串，两种形式在内部分别处理：
// - 对象：IPC 路径走结构化克隆直传，保留 undefined 可选字段（Message.reasoningContent /
//   agentTrace / reasoningDetails 等），避免 JSON.stringify 静默丢弃这些字段；
//   fetch 路径在下方统一序列化为字符串。
// - 字符串：视为已序列化，IPC 路径反序列化为对象后传入，fetch 路径直接使用。
//   保留字符串形式是为了不改动现有调用点（createNode / branchNode 等已 JSON.stringify）。
async function request<T>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T> {
  const method = init?.method ?? 'GET';
  let ipcBody: unknown = undefined;
  if (init?.body !== undefined && init?.body !== null) {
    ipcBody = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  }

  if (isElectron && window.powerChat) {
    const result = await window.powerChat.request(method, `/api${path.startsWith('/api') ? path.slice(4) : path}`, ipcBody);
    if (result.error || result.status >= 400) {
      // 同时带 error code 与 message，让上层用 String.includes 区分错误类型时
      // 与 HTTP 路径（抛整个 JSON body 文本）行为一致
      const code = result.error?.error ?? 'unknown';
      const msg = result.error?.message;
      throw new Error(`[${result.status}] ${code}${msg ? `: ${msg}` : ''}`);
    }
    return result.body as T;
  }

  // 浏览器 dev：fetch body 必须是字符串，对象类型需先序列化
  const rawBody = init?.body;
  const fetchBody = rawBody === undefined || rawBody === null
    ? undefined
    : typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
  const res = await fetch(`/api${path.startsWith('/api') ? path.slice(4) : path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: fetchBody,
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

  async restoreNode(snapshot: { node: Node; messages: Message[]; edges: Edge[] }): Promise<void> {
    // 直传对象而非 JSON.stringify(snapshot)：序列化会丢弃 Message/Node 上 undefined 的可选字段
    // （reasoningContent / wasResumed / agentTrace / reasoningDetails 等），导致后端写回不完整、
    // 后续读取时类型错位。IPC 路径走结构化克隆保留全字段；fetch 路径在 request() 内部统一序列化。
    return request<void>('/nodes/restore', { method: 'POST', body: snapshot });
  },

  async deleteEdge(id: string): Promise<void> {
    return request<void>(`/edges/${id}`, { method: 'DELETE' });
  },

  async updateNode(id: string, patch: Partial<Pick<Node, 'positionX' | 'positionY' | 'collapsed' | 'title'>>): Promise<Node> {
    return request(`/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },

  // 用户主动触发节点标题重新生成。
  // 错误（HTTP 4xx/5xx）由 request() 抛出，调用方负责 toast 提示——
  // 与"自动生成静默吞错"的旧行为相反，错误必须可见可决策（用户主权 / E015 同思路）。
  async regenerateNodeTitle(nodeId: string): Promise<{ title: string }> {
    return request(`/nodes/${nodeId}/regenerate-title`, { method: 'POST' });
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

  async write(req: WriteRequest): Promise<{ node: Node; edges: Edge[]; streamUrl: string }> {
    return request('/write', { method: 'POST', body: JSON.stringify(req) });
  },

  async streamWrite(streamUrl: string, onEvent: (e: StreamEvent) => void): Promise<void> {
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
