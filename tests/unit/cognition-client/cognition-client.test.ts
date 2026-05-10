// cognition-client 单元测试
// 不依赖 mock-server / 真实 Alter 服务——通过 vi.mock 拦截 settings 与全局 fetch。
//
// 覆盖：
// - composeSystemPrompt 拼接逻辑
// - buildCycleTurns 构造（system/tool 跳过、assistant 必带 personaVersion）
// - resolveTarget 守卫（enabled=false / userId 空 / baseUrl 空 → 不发请求）
// - fireAsyncCycle 缓存更新策略（skipped 不覆盖 personaPrompt）
// - runCycle 失败/超时返回 null（不抛）
// - health 检查
// - 干预接口（forget / freeze / unfreeze）user_id 注入

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMMessage, Settings } from '../../../src/types';

// 用 vi.hoisted + vi.mock 拦截 settings 模块——避开真实文件 IO
const settingsState = vi.hoisted(() => ({
  current: null as Settings | null,
  patches: [] as Partial<Settings>[],
}));

vi.mock('../../../src/modules/settings', () => ({
  getSettings: vi.fn(async () => settingsState.current),
  putSettings: vi.fn(async (patch: Partial<Settings>) => {
    settingsState.patches.push(patch);
    settingsState.current = { ...(settingsState.current as Settings), ...patch };
    return settingsState.current as Settings;
  }),
}));

import {
  composeSystemPrompt,
  buildCycleTurns,
  runCycle,
  fireAsyncCycle,
  getCachedInjection,
  health,
  forget,
  freeze,
  unfreeze,
  getState,
} from '../../../src/modules/cognition-client';

// ---- Settings 工厂：构造一份完整可用的 Settings ----
function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    llmBaseUrl: '',
    llmModel: '',
    llmFastModel: '',
    llmApiKey: '',
    tavilyApiKey: '',
    thinkingModeEnabled: false,
    thinkingEffort: 'medium',
    provider: 'custom',
    privacyAcknowledged: false,
    cognitionEnabled: true,
    cognitionBaseUrl: 'http://localhost:8000',
    cognitionUserId: 'alice@example.com',
    cognitionLastPersonaPrompt: '',
    cognitionLastPersonaVersion: 'v0',
    cognitionLastContext: 'default',
    cognitionLastCycleAt: 0,
    ...overrides,
  };
}

// ---- 全局 fetch mock 工具 ----
function mockFetchOnce(handler: (input: { url: string; method: string; body?: unknown }) => Response | Promise<Response>) {
  // @ts-expect-error 测试期覆写全局 fetch
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return handler({ url: url.toString(), method, body });
  });
}

beforeEach(() => {
  settingsState.current = makeSettings();
  settingsState.patches = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('composeSystemPrompt', () => {
  it('personaPrompt 为空时原样返回 base', () => {
    expect(composeSystemPrompt('你是助手', '')).toBe('你是助手');
  });

  it('非空时拼接到 base 之后并加分隔标记', () => {
    const out = composeSystemPrompt('你是助手', '此用户偏好简短回答');
    expect(out).toBe('你是助手\n\n[user-cognition directives]\n此用户偏好简短回答');
  });
});

describe('buildCycleTurns', () => {
  it('跳过 system 和 tool 角色，保留 user/assistant', () => {
    const history: LLMMessage[] = [
      { role: 'system', content: 'sysprompt' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', personaVersion: 'abc' } as LLMMessage & { personaVersion: string },
      { role: 'tool', content: 'tool result', toolCallId: 't1' },
    ];
    const turns = buildCycleTurns(history, '下一句', 'abc');
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(turns[1]!.persona_version).toBe('abc');
  });

  it('assistant 缺 personaVersion 时 fallback 为 v0', () => {
    const history: LLMMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ];
    const turns = buildCycleTurns(history, '', 'vX');
    expect(turns[1]!.persona_version).toBe('v0');
  });

  it('当前 user 输入为空时不追加', () => {
    const history: LLMMessage[] = [{ role: 'user', content: 'q' }];
    const turns = buildCycleTurns(history, '', 'v0');
    expect(turns).toHaveLength(1);
  });

  it('生成的 turn_id 对相同 (idx, role, content) 稳定', () => {
    const t1 = buildCycleTurns([], 'hello', 'v0');
    const t2 = buildCycleTurns([], 'hello', 'v0');
    expect(t1[0]!.turn_id).toBe(t2[0]!.turn_id);
  });
});

describe('getCachedInjection', () => {
  it('cognitionEnabled=false 时返回空 personaPrompt', async () => {
    settingsState.current = makeSettings({ cognitionEnabled: false, cognitionLastPersonaPrompt: 'should-not-leak' });
    const inj = await getCachedInjection();
    expect(inj.personaPrompt).toBe('');
    expect(inj.personaVersion).toBe('v0');
  });

  it('启用时直接返回缓存值', async () => {
    settingsState.current = makeSettings({
      cognitionLastPersonaPrompt: '偏好简短',
      cognitionLastPersonaVersion: 'k7x',
    });
    const inj = await getCachedInjection();
    expect(inj.personaPrompt).toBe('偏好简短');
    expect(inj.personaVersion).toBe('k7x');
  });
});

describe('runCycle 守卫', () => {
  it('cognitionEnabled=false 时立即返回 null，不发请求', async () => {
    settingsState.current = makeSettings({ cognitionEnabled: false });
    const fetchSpy = vi.fn();
    // @ts-expect-error
    globalThis.fetch = fetchSpy;
    const result = await runCycle([{ turn_id: 't1', role: 'user', content: 'hi' }]);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cognitionUserId 为空时返回 null', async () => {
    settingsState.current = makeSettings({ cognitionUserId: '' });
    const fetchSpy = vi.fn();
    // @ts-expect-error
    globalThis.fetch = fetchSpy;
    const result = await runCycle([]);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('网络失败返回 null（不抛）', async () => {
    // @ts-expect-error
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await runCycle([{ turn_id: 't1', role: 'user', content: 'hi' }]);
    expect(result).toBeNull();
  });

  it('200 响应解析为 CycleResult（snake_case → camelCase）', async () => {
    mockFetchOnce(async () => new Response(
      JSON.stringify({
        user_id: 'alice@example.com',
        persona_prompt: '偏好简短',
        skipped: false,
        context: 'coding',
        duration_ms: 123.4,
        metrics: { llm_calls: 4 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const result = await runCycle([{ turn_id: 't1', role: 'user', content: 'hi' }]);
    expect(result).toEqual({
      personaPrompt: '偏好简短',
      skipped: false,
      context: 'coding',
      durationMs: 123.4,
      metrics: { llm_calls: 4 },
    });
  });
});

describe('fireAsyncCycle 缓存策略', () => {
  it('成功且未 skipped：写入 personaPrompt + version + context', async () => {
    mockFetchOnce(async () => new Response(
      JSON.stringify({
        user_id: 'alice@example.com',
        persona_prompt: '新指令',
        skipped: false,
        context: 'decision_making',
        duration_ms: 1500,
        metrics: {},
      }),
      { status: 200 },
    ));
    await fireAsyncCycle([{ turn_id: 't1', role: 'user', content: 'hi' }]);
    expect(settingsState.patches).toHaveLength(1);
    const patch = settingsState.patches[0]!;
    expect(patch.cognitionLastPersonaPrompt).toBe('新指令');
    expect(patch.cognitionLastContext).toBe('decision_making');
    expect(typeof patch.cognitionLastCycleAt).toBe('number');
    expect(patch.cognitionLastPersonaVersion).toBeTruthy();
  });

  it('skipped=true：保留旧 personaPrompt，仅刷新 lastCycleAt 与 context', async () => {
    settingsState.current = makeSettings({
      cognitionLastPersonaPrompt: '旧指令',
      cognitionLastPersonaVersion: 'old',
    });
    mockFetchOnce(async () => new Response(
      JSON.stringify({
        user_id: 'alice@example.com',
        persona_prompt: null,
        skipped: true,
        context: 'default',
        duration_ms: 5,
        metrics: {},
      }),
      { status: 200 },
    ));
    await fireAsyncCycle([{ turn_id: 't1', role: 'user', content: 'hi' }]);
    const patch = settingsState.patches[0]!;
    expect(patch.cognitionLastPersonaPrompt).toBeUndefined();
    expect(patch.cognitionLastPersonaVersion).toBeUndefined();
    expect(patch.cognitionLastContext).toBe('default');
    expect(typeof patch.cognitionLastCycleAt).toBe('number');
  });

  it('网络失败完全不更新 settings（patches 为空）', async () => {
    // @ts-expect-error
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await fireAsyncCycle([{ turn_id: 't1', role: 'user', content: 'hi' }]);
    expect(settingsState.patches).toHaveLength(0);
  });
});

describe('health', () => {
  it('200 响应返回 ok=true', async () => {
    mockFetchOnce(async () => new Response('{"status":"ok"}', { status: 200 }));
    const r = await health();
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  it('网络异常返回 ok=false 且带 error', async () => {
    // @ts-expect-error
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    const r = await health();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ETIMEDOUT');
  });

  it('支持 overrideBaseUrl（设置页"测试连接"用得上）', async () => {
    let calledUrl = '';
    // @ts-expect-error
    globalThis.fetch = vi.fn(async (url: string) => {
      calledUrl = String(url);
      return new Response('{}', { status: 200 });
    });
    await health('http://other-host:9000/');
    expect(calledUrl).toBe('http://other-host:9000/v1/health');
  });

  it('baseUrl 为空时返回 ok=false', async () => {
    settingsState.current = makeSettings({ cognitionBaseUrl: '' });
    const r = await health();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('empty');
  });
});

describe('干预接口注入 user_id', () => {
  it('forget POST body 含 user_id + item_id', async () => {
    let captured: { url: string; body?: unknown } = { url: '' };
    mockFetchOnce(async (req) => {
      captured = req;
      return new Response('{}', { status: 200 });
    });
    const ok = await forget('obs_123');
    expect(ok).toBe(true);
    expect(captured.url).toBe('http://localhost:8000/v1/forget');
    expect(captured.body).toEqual({ user_id: 'alice@example.com', item_id: 'obs_123' });
  });

  it('freeze / unfreeze 走对应路径', async () => {
    const urls: string[] = [];
    // @ts-expect-error
    globalThis.fetch = vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response('{}', { status: 200 });
    });
    await freeze('p1');
    await unfreeze('p2');
    expect(urls[0]).toBe('http://localhost:8000/v1/freeze');
    expect(urls[1]).toBe('http://localhost:8000/v1/unfreeze');
  });

  it('getState URL encode user_id（邮箱含 @）', async () => {
    let calledUrl = '';
    mockFetchOnce(async (req) => {
      calledUrl = req.url;
      return new Response('{"user_id":"alice@example.com"}', { status: 200 });
    });
    await getState();
    expect(calledUrl).toBe('http://localhost:8000/v1/state/alice%40example.com');
  });
});
