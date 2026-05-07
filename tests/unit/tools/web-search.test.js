import { describe, it, expect, vi } from 'vitest';
// 在 import web-search 之前 mock settings 模块；避免触达持久化层
vi.mock('../../../src/modules/settings.js', () => ({
    getSettings: vi.fn(),
}));
import { webSearchTool } from '../../../src/modules/tools/web-search';
import { getSettings } from '../../../src/modules/settings';
import { FAKE_SETTINGS_WITH_KEY, FAKE_SETTINGS_NO_KEY, setupToolTestEnv } from './_helpers';
const mockGetSettings = vi.mocked(getSettings);
setupToolTestEnv(() => mockGetSettings.mockResolvedValue(FAKE_SETTINGS_WITH_KEY));
describe('web_search 工具单元测试', () => {
    it('USE_MOCK_TOOLS=1 时返回 mock 数据，不调真实 fetch', async () => {
        process.env.USE_MOCK_TOOLS = '1';
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const result = await webSearchTool.execute({ query: 'foo' });
        expect(result.success).toBe(true);
        expect(result.data.results.length).toBeGreaterThan(0);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
    it('tavilyApiKey 未配置时返回 tavily_key_not_configured（决策 15）', async () => {
        mockGetSettings.mockResolvedValue(FAKE_SETTINGS_NO_KEY);
        const result = await webSearchTool.execute({ query: 'foo' });
        expect(result.success).toBe(false);
        expect(result.error).toBe('tavily_key_not_configured');
    });
    it('真实路径：构造请求体含 api_key/query/max_results/search_depth=basic', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
        await webSearchTool.execute({ query: 'climate change', maxResults: 5 });
        expect(fetchSpy).toHaveBeenCalledOnce();
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://api.tavily.com/search');
        const body = JSON.parse(init.body);
        expect(body.api_key).toBe('tvly-test-key');
        expect(body.query).toBe('climate change');
        expect(body.max_results).toBe(5);
        expect(body.search_depth).toBe('basic');
    });
    it('maxResults 缺省时回退 5，且超出 1-10 范围被夹紧', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
        await webSearchTool.execute({ query: 'a' });
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body).max_results).toBe(5);
        fetchSpy.mockClear();
        await webSearchTool.execute({ query: 'a', maxResults: 99 });
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body).max_results).toBe(10);
        fetchSpy.mockClear();
        await webSearchTool.execute({ query: 'a', maxResults: 0 });
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body).max_results).toBe(1);
    });
    it('真实路径：响应正确映射 results.content → snippet', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
            results: [
                { title: 'T1', url: 'https://x.com/1', content: 'C1' },
                { title: 'T2', url: 'https://x.com/2', content: 'C2' },
            ],
        }), { status: 200 }));
        const result = await webSearchTool.execute({ query: 'x' });
        expect(result.success).toBe(true);
        expect(result.data.results).toEqual([
            { title: 'T1', url: 'https://x.com/1', snippet: 'C1' },
            { title: 'T2', url: 'https://x.com/2', snippet: 'C2' },
        ]);
    });
    it('401 → tavily_unauthorized', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
        const result = await webSearchTool.execute({ query: 'x' });
        expect(result.error).toBe('tavily_unauthorized');
    });
    it('429 → tavily_rate_limited', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }));
        const result = await webSearchTool.execute({ query: 'x' });
        expect(result.error).toBe('tavily_rate_limited');
    });
    it('其他 5xx → tavily_http_<status>', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
        const result = await webSearchTool.execute({ query: 'x' });
        expect(result.error).toMatch(/^tavily_http_500/);
    });
    it('网络异常 → tavily_network_error', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        const result = await webSearchTool.execute({ query: 'x' });
        expect(result.error).toMatch(/^tavily_network_error/);
    });
    it('用户已 abort 时不调 fetch，返回 aborted_before_start', async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const result = await webSearchTool.execute({ query: 'x' }, ctrl.signal);
        expect(result.success).toBe(false);
        expect(result.error).toBe('aborted_before_start');
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
