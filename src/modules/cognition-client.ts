// 对 Alter (cognition) HTTP 服务的本地客户端封装。
//
// 接入策略（决策 6 + 阶段 2 拍板的"异步缓存"）：
// - 主对话路径不等 cycle 返回，永远直接读 settings.cognitionLastPersonaPrompt 注入；
// - 每次 sendMessage 后通过 fireAsyncCycle 后台刷新缓存，下一轮即可用上新 personaPrompt；
// - 任何网络/服务异常都不抛给主流程——主对话必须保持可用，cognition 是增益不是依赖。
//
// 与 llm-client.ts 一样使用 Node 18+ 全局 fetch；不引入新依赖。
//
// 协议：完全遵循 Alter 服务的 OpenAPI 3.1.0（http://localhost:8000/openapi.json）
// 任何字段命名差异都在本文件转换（snake_case ↔ camelCase）。

import type { LLMMessage, Settings } from '../types.js';
import { getSettings, putSettings } from './settings.js';

// === Wire-level types（与 OpenAPI 完全对齐，snake_case） ===

export interface TurnIn {
  turn_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  persona_version?: string | null;
  timestamp?: number | null;
}

interface CycleRequestBody {
  user_id: string;
  turns: TurnIn[];
  force?: boolean;
  custom_routes?: Record<string, string[]> | null;
}

interface CycleResponseBody {
  user_id: string;
  persona_prompt: string | null;
  skipped: boolean;
  context: string;
  duration_ms: number;
  metrics: Record<string, unknown>;
}

// === 对外 API（camelCase） ===

export interface CycleResult {
  personaPrompt: string | null;
  skipped: boolean;
  context: string;
  durationMs: number;
  metrics: Record<string, unknown>;
}

export interface InjectionContext {
  personaPrompt: string;
  personaVersion: string;
}

export interface HealthResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

// === 内部辅助：守卫与 HTTP 抓取 ===

interface ResolvedTarget {
  baseUrl: string;
  userId: string;
}

// cognition 是否可用：enabled + baseUrl + userId 三件齐全才发起请求
async function resolveTarget(): Promise<ResolvedTarget | null> {
  const s = await getSettings();
  if (!s.cognitionEnabled) return null;
  if (!s.cognitionBaseUrl) return null;
  if (!s.cognitionUserId) return null;
  return {
    baseUrl: s.cognitionBaseUrl.replace(/\/$/, ''),
    userId: s.cognitionUserId,
  };
}

// 统一的 HTTP 抓取：成功返回 JSON，失败返回 null（调用方自行决定容错语义）。
// 永不抛——内层 catch 把所有 fetch / parse 异常吞掉记日志。
async function httpJson<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[cognition] ${method} ${url} → ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.warn(`[cognition] ${method} ${url} failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// === 核心：cycle 与缓存策略 ===

/**
 * 同步触发一次 cycle 并返回结果。失败时返回 null（不抛）。
 * 主对话路径不应直接调本函数（会引入 5-15s 延迟），由 fireAsyncCycle 在后台调；
 * 干预 UI（"立即刷新画像"按钮）等明确需要等待结果的场景才调本函数。
 */
export async function runCycle(turns: TurnIn[], opts?: { force?: boolean; customRoutes?: Record<string, string[]> | null }): Promise<CycleResult | null> {
  const target = await resolveTarget();
  if (!target) return null;
  const body: CycleRequestBody = {
    user_id: target.userId,
    turns,
    force: opts?.force ?? false,
    custom_routes: opts?.customRoutes ?? null,
  };
  const resp = await httpJson<CycleResponseBody>('POST', `${target.baseUrl}/v1/cycle`, body);
  if (!resp) return null;
  return {
    personaPrompt: resp.persona_prompt,
    skipped: resp.skipped,
    context: resp.context,
    durationMs: resp.duration_ms,
    metrics: resp.metrics,
  };
}

/**
 * 后台触发 cycle 并把成功结果写入 settings 缓存——给下一轮 sendMessage 用。
 * 永不抛，永不阻塞调用方；调用方应 fire-and-forget：
 *
 *   void cognitionClient.fireAsyncCycle(turns);
 *
 * skipped=true 时（cognition 命中冷却）也会更新 lastCycleAt 让下次冷却判断准确。
 */
export async function fireAsyncCycle(turns: TurnIn[]): Promise<void> {
  try {
    const result = await runCycle(turns);
    if (!result) return;
    // skipped 时 personaPrompt 通常为 null（cognition 内部直接返回缓存的 last persona），
    // 此时不要把缓存覆盖成空字符串——保持上次有效值；只更新 lastCycleAt 与 context
    const patch: Partial<Settings> = {
      cognitionLastContext: result.context || 'default',
      cognitionLastCycleAt: Date.now(),
    };
    if (!result.skipped && result.personaPrompt) {
      patch.cognitionLastPersonaPrompt = result.personaPrompt;
      // version：用 cycle 完成时间戳的 base36 简短字符串
      patch.cognitionLastPersonaVersion = Date.now().toString(36);
    }
    await putSettings(patch);
  } catch (e) {
    // 兜底：putSettings 等任何环节抛错都不能影响主对话
    console.warn('[cognition] fireAsyncCycle background error:', (e as Error)?.message ?? e);
  }
}

/**
 * 直接读缓存——主对话路径每次发消息前调用，零延迟。
 * cognitionEnabled=false 或缓存为空时返回 { personaPrompt: '', personaVersion: 'v0' }。
 */
export async function getCachedInjection(): Promise<InjectionContext> {
  const s = await getSettings();
  if (!s.cognitionEnabled) {
    return { personaPrompt: '', personaVersion: 'v0' };
  }
  return {
    personaPrompt: s.cognitionLastPersonaPrompt || '',
    personaVersion: s.cognitionLastPersonaVersion || 'v0',
  };
}

/**
 * 把基础 system prompt 与 cognition 的 personaPrompt 拼接。personaPrompt 空时原样返回 base。
 *
 * 拼接策略（决策 3）：persona 在 base 之后——基础人格优先，行为修饰后置。
 * 用清晰的分隔标记让用户/调试时能看出注入位置。
 */
export function composeSystemPrompt(base: string, personaPrompt: string): string {
  if (!personaPrompt) return base;
  return `${base}\n\n[user-cognition directives]\n${personaPrompt}`;
}

/**
 * 把 LLMMessage[] + 当前 user 输入 转成 cognition 期望的 TurnIn[]。
 * 规则：
 * - role='system' 的消息跳过（cognition 不关心）
 * - role='tool' 也跳过（agent 内部产物，不属于人类对话）
 * - assistant 必须带 persona_version；缺失时 fallback 'v0'
 * - turn_id 用稳定 hash（content + role + index）让 cognition 同一对话多次调用能识别同一 turn
 */
export function buildCycleTurns(historyMessages: LLMMessage[], currentUserContent: string, currentAssistantPersonaVersion: string): TurnIn[] {
  const turns: TurnIn[] = [];
  let idx = 0;
  for (const m of historyMessages) {
    if (m.role !== 'user' && m.role !== 'assistant') {
      idx++;
      continue;
    }
    const turn: TurnIn = {
      turn_id: makeTurnId(idx, m.role, m.content),
      role: m.role,
      content: m.content,
    };
    if (m.role === 'assistant') {
      turn.persona_version = m.personaVersion ?? 'v0';
    }
    turns.push(turn);
    idx++;
  }
  // 当前 user 消息——尚未持久化时也要传给 cognition
  if (currentUserContent) {
    turns.push({
      turn_id: makeTurnId(idx, 'user', currentUserContent),
      role: 'user',
      content: currentUserContent,
    });
  }
  // 注：当前 assistant 占位消息此时 content 为空，不入 turns；
  // 等下一轮 sendMessage 时，上一条 assistant 已经有完整内容，会被作为历史传入。
  // currentAssistantPersonaVersion 留给调用方参考（写入 Message.personaVersion 时用），不入 turns
  void currentAssistantPersonaVersion;
  return turns;
}

// 简单 hash：足够稳定的 turn_id 生成；不要求加密强度，只要同输入同输出
function makeTurnId(idx: number, role: string, content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = ((h << 5) - h + content.charCodeAt(i)) | 0;
  return `t${idx}_${role}_${(h >>> 0).toString(36)}`;
}

// === 干预 / 查看接口（设置页画像面板用） ===

export async function getState(): Promise<unknown | null> {
  const t = await resolveTarget();
  if (!t) return null;
  return httpJson<unknown>('GET', `${t.baseUrl}/v1/state/${encodeURIComponent(t.userId)}`);
}

export async function deleteState(): Promise<boolean> {
  const t = await resolveTarget();
  if (!t) return false;
  const resp = await httpJson<unknown>('DELETE', `${t.baseUrl}/v1/state/${encodeURIComponent(t.userId)}`);
  return resp !== null;
}

export async function getSummary(): Promise<Record<string, string> | null> {
  const t = await resolveTarget();
  if (!t) return null;
  return httpJson<Record<string, string>>('GET', `${t.baseUrl}/v1/state/${encodeURIComponent(t.userId)}/summary`);
}

export async function explain(context = 'default'): Promise<unknown | null> {
  const t = await resolveTarget();
  if (!t) return null;
  const url = `${t.baseUrl}/v1/explain/${encodeURIComponent(t.userId)}?context=${encodeURIComponent(context)}`;
  return httpJson<unknown>('GET', url);
}

export async function forget(itemId: string): Promise<boolean> {
  const t = await resolveTarget();
  if (!t) return false;
  const resp = await httpJson<unknown>('POST', `${t.baseUrl}/v1/forget`, { user_id: t.userId, item_id: itemId });
  return resp !== null;
}

export async function freeze(patternId: string): Promise<boolean> {
  const t = await resolveTarget();
  if (!t) return false;
  const resp = await httpJson<unknown>('POST', `${t.baseUrl}/v1/freeze`, { user_id: t.userId, pattern_id: patternId });
  return resp !== null;
}

export async function unfreeze(patternId: string): Promise<boolean> {
  const t = await resolveTarget();
  if (!t) return false;
  const resp = await httpJson<unknown>('POST', `${t.baseUrl}/v1/unfreeze`, { user_id: t.userId, pattern_id: patternId });
  return resp !== null;
}

export async function listUsers(): Promise<unknown | null> {
  const t = await resolveTarget();
  if (!t) return null;
  return httpJson<unknown>('GET', `${t.baseUrl}/v1/users`);
}

export async function getMetrics(): Promise<unknown | null> {
  const t = await resolveTarget();
  if (!t) return null;
  return httpJson<unknown>('GET', `${t.baseUrl}/v1/metrics`);
}

export async function getCognitionSettings(): Promise<unknown | null> {
  const t = await resolveTarget();
  if (!t) return null;
  return httpJson<unknown>('GET', `${t.baseUrl}/v1/settings`);
}

export async function putCognitionSettings(patch: Record<string, unknown>): Promise<unknown | null> {
  const t = await resolveTarget();
  if (!t) return null;
  return httpJson<unknown>('PUT', `${t.baseUrl}/v1/settings`, patch);
}

export async function replay(
  conversations: TurnIn[][],
  opts?: { force?: boolean; persist?: boolean; fromEmpty?: boolean },
): Promise<unknown | null> {
  const t = await resolveTarget();
  if (!t) return null;
  return httpJson<unknown>('POST', `${t.baseUrl}/v1/replay`, {
    user_id: t.userId,
    conversations,
    force: opts?.force ?? true,
    persist: opts?.persist ?? false,
    from_empty: opts?.fromEmpty ?? false,
  });
}

/**
 * 健康检查：返回 ok=true 表示服务可达且 /v1/health 200。
 * 即使 cognitionEnabled=false 或 userId 为空也尝试连接（设置页"测试连接"按钮用得上）。
 */
export async function health(overrideBaseUrl?: string): Promise<HealthResult> {
  const s = await getSettings();
  const baseUrl = (overrideBaseUrl ?? s.cognitionBaseUrl ?? '').replace(/\/$/, '');
  if (!baseUrl) return { ok: false, error: 'baseUrl is empty' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    const res = await fetch(`${baseUrl}/v1/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: true, status: res.status, body };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
