import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/modules/settings.js', () => ({
  getSettings: vi.fn(),
}));

import { fetchPageTool, FETCH_PAGE_MAX_CHARS } from '../../../src/modules/tools/fetch-page';
import { getSettings } from '../../../src/modules/settings';
import {
  FAKE_SETTINGS_WITH_KEY,
  FAKE_SETTINGS_NO_KEY,
  mockTavilyExtractOk,
  setupToolTestEnv,
} from './_helpers';

const mockGetSettings = vi.mocked(getSettings);
setupToolTestEnv(() => mockGetSettings.mockResolvedValue(FAKE_SETTINGS_WITH_KEY));

describe('fetch_page 工具单元测试', () => {
  it('USE_MOCK_TOOLS=1 时返回 mock 数据，不调真实 fetch', async () => {
    process.env.USE_MOCK_TOOLS = '1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await fetchPageTool.execute({ url: 'https://example.com' });
    expect(result.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('非 http/https URL 返回 invalid_url_scheme', async () => {
    const result = await fetchPageTool.execute({ url: 'ftp://example.com' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_url_scheme');
  });

  it('tavilyApiKey 未配置时返回 tavily_key_not_configured', async () => {
    mockGetSettings.mockResolvedValue(FAKE_SETTINGS_NO_KEY);
    const result = await fetchPageTool.execute({ url: 'https://example.com' });
    expect(result.error).toBe('tavily_key_not_configured');
  });

  it('真实路径：构造请求体含 api_key/urls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: [{ url: 'https://x.com', raw_content: 'hello' }] }), { status: 200 }),
    );
    await fetchPageTool.execute({ url: 'https://x.com' });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.tavily.com/extract');
    const body = JSON.parse(init!.body as string);
    expect(body.api_key).toBe('tvly-test-key');
    expect(body.urls).toEqual(['https://x.com']);
  });

  it('真实路径：响应正确映射 raw_content → content，未截断', async () => {
    mockTavilyExtractOk('https://x.com', 'short content here');
    const result = await fetchPageTool.execute({ url: 'https://x.com' });
    expect(result.success).toBe(true);
    expect(result.data!.content).toBe('short content here');
    expect(result.data!.truncated).toBe(false);
    expect(result.data!.url).toBe('https://x.com');
  });

  it('R018 守卫：raw_content 超 50_000 字符时截断并标记 truncated=true', async () => {
    const longContent = 'x'.repeat(FETCH_PAGE_MAX_CHARS + 10_000);
    mockTavilyExtractOk('https://x.com', longContent);
    const result = await fetchPageTool.execute({ url: 'https://x.com' });
    expect(result.success).toBe(true);
    expect(result.data!.content.length).toBe(FETCH_PAGE_MAX_CHARS);
    expect(result.data!.truncated).toBe(true);
  });

  it('Tavily 返回空 results → tavily_extract_empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const result = await fetchPageTool.execute({ url: 'https://x.com' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('tavily_extract_empty');
  });

  it('共享错误分类（mapTavilyHttpFailure）：401/429 与 web_search 一致', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    expect((await fetchPageTool.execute({ url: 'https://x.com' })).error).toBe('tavily_unauthorized');

    vi.restoreAllMocks();
    mockGetSettings.mockResolvedValue(FAKE_SETTINGS_WITH_KEY);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }));
    expect((await fetchPageTool.execute({ url: 'https://x.com' })).error).toBe('tavily_rate_limited');
  });

  it('用户已 abort 时不调 fetch，返回 aborted_before_start', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await fetchPageTool.execute({ url: 'https://x.com' }, ctrl.signal);
    expect(result.error).toBe('aborted_before_start');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
