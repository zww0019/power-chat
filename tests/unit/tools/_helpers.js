import { vi, beforeEach, afterEach } from 'vitest';
// unit 测试共享：避免 web-search.test 与 fetch-page.test 重复定义 FAKE_SETTINGS / mock 响应 / setup
// （vi.mock 必须在每个测试文件顶部 hoist，不能抽 helper；其他常量 / 工厂函数 / 生命周期钩子可共享）
export const FAKE_SETTINGS_WITH_KEY = {
    llmBaseUrl: '',
    llmModel: '',
    llmFastModel: '',
    llmApiKey: '',
    tavilyApiKey: 'tvly-test-key',
    thinkingModeEnabled: false,
    privacyAcknowledged: false,
};
export const FAKE_SETTINGS_NO_KEY = {
    ...FAKE_SETTINGS_WITH_KEY,
    tavilyApiKey: '',
};
// 包装一个 Tavily Extract API 风格的成功响应（results[0].raw_content 模式）
export function mockTavilyExtractOk(url, rawContent) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: [{ url, raw_content: rawContent }] }), { status: 200 }));
}
// 注册 unit 测试共享的生命周期钩子：每用例前清 mock + 清 USE_MOCK_TOOLS 环境变量；
// resetMocks 由调用方传入，是因为 vi.mocked(...) 必须在测试文件 import 后才能 wrap，无法跨文件抽取
export function setupToolTestEnv(resetMocks) {
    beforeEach(() => {
        vi.restoreAllMocks();
        delete process.env.USE_MOCK_TOOLS;
        resetMocks();
    });
    afterEach(() => {
        delete process.env.USE_MOCK_TOOLS;
    });
}
