// web_search 工具：基于 Tavily Search API 的网络搜索（D014）。
//
// USE_MOCK_TOOLS=1 时返回固定 mock 数据；其他情况走真实 Tavily 端点。
// 真实路径：POST https://api.tavily.com/search
//   request:  { api_key, query, max_results, search_depth: 'basic' }
//   response: { results: [{ title, url, content }] }
//
// 失败分类：
// - tavily_key_not_configured：settings.tavilyApiKey 为空（决策 15）
// - 401 → tavily_unauthorized：key 无效
// - 429 → tavily_rate_limited：超限
// - 超时 30s → tavily_timeout
// - 其他 → tavily_network_error: <message>
//
// 工具描述写法关键约束：
// - 措辞强调"明确动作动词触发"，对应原则 C
// - 不出现"画布""节点"等产品概念（R010）
import { getSettings } from '../settings.js';
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
export const TAVILY_TIMEOUT_MS = 30_000; // 决策 17；fetch-page 共享此常量，保持单一来源
const TOOL_DESCRIPTION = `基于关键词调用网络搜索引擎，返回若干相关结果（标题/URL/摘要）。

适用场景：用户用动作动词（"搜一下""查一下""找一下""帮我搜"）明确请求外部信息时。

不适用场景：开放性话题讨论、征求观点、基于已有知识可回答的问题——这些应直接对话，不要使用本工具。`;
export const webSearchTool = {
    name: 'web_search',
    description: TOOL_DESCRIPTION,
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: '搜索关键词。简洁、信息密度高；避免冗长自然语言疑问句。',
            },
            maxResults: {
                type: 'number',
                description: '返回结果数（1-10），默认 5',
                default: 5,
            },
        },
        required: ['query'],
    },
    async execute(args, signal) {
        if (signal?.aborted) {
            return { success: false, error: 'aborted_before_start' };
        }
        if (process.env.USE_MOCK_TOOLS === '1') {
            return mockSearchResult(args.query);
        }
        const settings = await getSettings();
        if (!settings.tavilyApiKey) {
            return { success: false, error: 'tavily_key_not_configured' };
        }
        return callTavilySearch(args, settings.tavilyApiKey, signal);
    },
};
// 超时与用户中断合并到同一 AbortSignal，确保 fetch 在任一条件满足时立即取消，
// 不依赖 fetch 自身的超时行为（各运行时实现不一致）
async function callTavilySearch(args, apiKey, userSignal) {
    const { signal, dispose } = combineSignalsWithTimeout(userSignal, TAVILY_TIMEOUT_MS);
    try {
        const res = await fetch(TAVILY_SEARCH_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: apiKey,
                query: args.query,
                max_results: clampMaxResults(args.maxResults),
                search_depth: 'basic',
            }),
            signal,
        });
        const failure = await mapTavilyHttpFailure(res);
        if (failure)
            return failure;
        const data = (await res.json());
        return {
            success: true,
            data: {
                results: (data.results ?? []).map((r) => ({
                    title: r.title ?? '',
                    url: r.url ?? '',
                    snippet: r.content ?? '',
                })),
            },
        };
    }
    catch (e) {
        return { success: false, error: classifyTavilyError(e, userSignal) };
    }
    finally {
        dispose();
    }
}
function clampMaxResults(n) {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 5;
    return Math.max(1, Math.min(10, v));
}
// USE_MOCK_TOOLS=1 时返回固定 mock 结果，端到端测试用
function mockSearchResult(query) {
    return {
        success: true,
        data: {
            results: [
                {
                    title: `[mock] ${query} 相关结果 #1`,
                    url: 'https://example.com/mock-1',
                    snippet: 'M1 占位摘要（USE_MOCK_TOOLS=1）：测试与开发场景使用。',
                },
                {
                    title: `[mock] ${query} 相关结果 #2`,
                    url: 'https://example.com/mock-2',
                    snippet: '内容来自 mock fixture。',
                },
            ],
        },
    };
}
// 把用户中断 signal 与 30s 超时 signal 合并：任一触发即 abort。
// AbortSignal.any 是 Node 20+ 标准 API；旧版本用手动监听 fallback
export function combineSignalsWithTimeout(userSignal, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
    const onUserAbort = () => ctrl.abort(userSignal?.reason);
    if (userSignal) {
        if (userSignal.aborted)
            ctrl.abort(userSignal.reason);
        else
            userSignal.addEventListener('abort', onUserAbort, { once: true });
    }
    return {
        signal: ctrl.signal,
        dispose: () => {
            clearTimeout(timer);
            userSignal?.removeEventListener('abort', onUserAbort);
        },
    };
}
// 区分超时 / 用户中断 / 网络错误三类
export function classifyTavilyError(e, userSignal) {
    const err = e;
    if (err?.name === 'TimeoutError')
        return 'tavily_timeout';
    if (err?.name === 'AbortError' || userSignal?.aborted)
        return 'aborted';
    return `tavily_network_error: ${err?.message ?? e}`;
}
// 把 Tavily HTTP 响应的失败状态码映射成 ToolExecutionResult；成功返回 null 让调用方继续解析。
// D010 共享：web_search 与 fetch_page 都用相同的 401/429/其他 错误分类
export async function mapTavilyHttpFailure(res) {
    if (res.status === 401)
        return { success: false, error: 'tavily_unauthorized' };
    if (res.status === 429)
        return { success: false, error: 'tavily_rate_limited' };
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, error: `tavily_http_${res.status}: ${text.slice(0, 200)}` };
    }
    return null;
}
