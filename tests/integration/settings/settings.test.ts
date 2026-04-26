import { describe, it, expect, beforeEach } from 'vitest';
import { api, BASE_URL } from '../helpers';

// settings-module 集成测试
// INV-9 + 旅程2 sad-1, sad-4, sad-5

beforeEach(async () => {
  await fetch(`${BASE_URL}/api/__test__/reset`, { method: 'POST' });
});

describe('settings: 配置读写', () => {
  it('GET 在未配置时返回空字符串字段', async () => {
    const s = await api<any>('/api/settings');
    expect(s.llmBaseUrl).toBe('');
    expect(s.llmModel).toBe('');
    expect(s.llmApiKey).toBe('');
    expect(s.thinkingModeEnabled).toBe(false);
  });

  it('PUT 写入真实 apiKey，但 GET 返回脱敏值', async () => {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        llmBaseUrl: 'https://api.deepseek.com/v1',
        llmModel: 'deepseek-reasoner',
        llmApiKey: 'sk-realkey1234567890',
        thinkingModeEnabled: true,
      }),
    });
    const s = await api<any>('/api/settings');
    expect(s.llmApiKey).not.toContain('realkey');
    expect(s.llmApiKey).toMatch(/^sk-•+\d+$/);
    expect(s.llmBaseUrl).toBe('https://api.deepseek.com/v1');
    expect(s.llmModel).toBe('deepseek-reasoner');
    expect(s.thinkingModeEnabled).toBe(true);
  });

  it('PUT 部分字段时其他字段保持不变', async () => {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        llmBaseUrl: 'https://x.com/v1',
        llmModel: 'x',
        llmApiKey: 'sk-abcdef0123456789',
      }),
    });
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ thinkingModeEnabled: true }),
    });
    const s = await api<any>('/api/settings');
    expect(s.llmBaseUrl).toBe('https://x.com/v1');
    expect(s.llmModel).toBe('x');
    expect(s.thinkingModeEnabled).toBe(true);
  });

  // M3 / D014：tavilyApiKey 字段沿用 D004 / R009 治理（脱敏 + 合并写入 + 不覆写真值）
  it('GET 默认未配置时 tavilyApiKey 为空字符串', async () => {
    const s = await api<{ tavilyApiKey: string }>('/api/settings');
    expect(s.tavilyApiKey).toBe('');
  });

  it('PUT 写入 tavilyApiKey 后 GET 返回脱敏值，明文不外泄', async () => {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ tavilyApiKey: 'tvly-realkey0123456789abcdef' }),
    });
    const s = await api<{ tavilyApiKey: string }>('/api/settings');
    expect(s.tavilyApiKey).not.toContain('realkey');
    expect(s.tavilyApiKey).toMatch(/•/);
  });

  it('tavilyApiKey 与 llmApiKey 互不干扰：PUT tavilyApiKey 不覆盖 llmApiKey', async () => {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ llmApiKey: 'sk-realllm0123456789' }),
    });
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ tavilyApiKey: 'tvly-realtavily0123456789' }),
    });
    const s = await api<{ llmApiKey: string; tavilyApiKey: string }>('/api/settings');
    // 两个 key 都已脱敏返回（含 •）；明文不外泄
    expect(s.llmApiKey).toContain('•');
    expect(s.llmApiKey).not.toContain('realllm');
    expect(s.tavilyApiKey).toContain('•');
    expect(s.tavilyApiKey).not.toContain('realtavily');
    // maskApiKey 取前 3 位 + 后 4 位：'tvly-realtavily...' → 'tvl•••6789'
    expect(s.tavilyApiKey.startsWith('tvl')).toBe(true);
  });
});

describe('settings: 连通测试（D1）', () => {
  it('未配置 baseURL 时 POST /api/settings/test 返回 502', async () => {
    await api('/api/settings/test', { method: 'POST', expectStatus: 502 });
  });

  it('USE_MOCK_LLM=1 已配置时返回 200 + ok:true', async () => {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        llmBaseUrl: 'https://api.deepseek.com/v1',
        llmModel: 'deepseek-reasoner',
        llmApiKey: 'sk-mock0123456789ab',
      }),
    });
    const result = await api<any>('/api/settings/test', { method: 'POST' });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.modelsAvailable)).toBe(true);
    expect(result.modelsAvailable.length).toBeGreaterThan(0);
  });
});

describe('settings: INV-9 未配置时禁止 LLM 调用', () => {
  it.skip('当 baseURL/model/apiKey 任一为空时，发消息返回 not_configured', async () => {
    // mock 模式下 USE_MOCK_LLM=1 总是绕过 isConfigured 检查；
    // 真实 LLM 模式（无环境变量）此 INV 会触发，已在代码中实现。
    // Stage 7 加双模式测试（USE_MOCK_LLM=0）后启用
  });
});
