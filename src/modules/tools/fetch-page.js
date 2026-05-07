// fetch_page 工具：基于 Tavily Extract API 的网页内容读取（D014）。
//
// 决策（D014）：fetch_page 不引入 playwright，改用 Tavily Extract content API 统一处理——
// - 不增加 electron 包体（playwright + chromium ~500MB）
// - 后端无需维护浏览器实例 / headless 进程池
// - 失败语义统一（与 web_search 同 provider，错误处理同源）
//
// USE_MOCK_TOOLS=1 时返回固定 mock 数据；其他情况走真实 Tavily 端点。
// 真实路径：POST https://api.tavily.com/extract
//   request:  { api_key, urls: [url] }
//   response: { results: [{ url, raw_content }] }
//
// 截断硬约束（§六 / R018）：单次返回最多 50_000 字符；超出截断标记 truncated=true。
import { getSettings } from '../settings.js';
import { combineSignalsWithTimeout, classifyTavilyError, mapTavilyHttpFailure, TAVILY_TIMEOUT_MS } from './web-search.js';
const TAVILY_EXTRACT_ENDPOINT = 'https://api.tavily.com/extract';
export const FETCH_PAGE_MAX_CHARS = 50_000;
const TOOL_DESCRIPTION = `抓取并读取指定 URL 的页面内容，返回标题与正文文本（已剥离脚本与样式）。

适用场景：用户用动作动词（"读一下""读这个网页""帮我看""抓取""查看这个链接"）明确请求阅读某个具体 URL 时。

不适用场景：用户只是提到一个 URL 但没要求读取、或仅想讨论某个网站——这些应保持对话，不要主动抓取。`;
export const fetchPageTool = {
    name: 'fetch_page',
    description: TOOL_DESCRIPTION,
    parameters: {
        type: 'object',
        properties: {
            url: {
                type: 'string',
                description: '要读取的网页 URL，必须是完整的 http/https 链接',
            },
        },
        required: ['url'],
    },
    async execute(args, signal) {
        if (signal?.aborted) {
            return { success: false, error: 'aborted_before_start' };
        }
        if (!/^https?:\/\//.test(args.url)) {
            return { success: false, error: 'invalid_url_scheme' };
        }
        if (process.env.USE_MOCK_TOOLS === '1') {
            return mockExtractResult(args.url);
        }
        const settings = await getSettings();
        if (!settings.tavilyApiKey) {
            return { success: false, error: 'tavily_key_not_configured' };
        }
        return callTavilyExtract(args, settings.tavilyApiKey, signal);
    },
};
async function callTavilyExtract(args, apiKey, userSignal) {
    const { signal, dispose } = combineSignalsWithTimeout(userSignal, TAVILY_TIMEOUT_MS);
    try {
        const res = await fetch(TAVILY_EXTRACT_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey, urls: [args.url] }),
            signal,
        });
        const failure = await mapTavilyHttpFailure(res);
        if (failure)
            return failure;
        const data = (await res.json());
        const first = data.results?.[0];
        if (!first || !first.raw_content) {
            return { success: false, error: 'tavily_extract_empty' };
        }
        const { content, truncated } = applyContentLimit(first.raw_content);
        return {
            success: true,
            data: {
                url: first.url ?? args.url,
                title: deriveTitleFromContent(content),
                content,
                truncated,
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
// R018 硬约束：单页内容上限 50_000 字符；超出截断并标记
function applyContentLimit(raw) {
    if (raw.length <= FETCH_PAGE_MAX_CHARS)
        return { content: raw, truncated: false };
    return { content: raw.slice(0, FETCH_PAGE_MAX_CHARS), truncated: true };
}
// Tavily Extract 不返回标题字段；从正文首行提取作为标题（保底机制，不展示也不影响 LLM 处理）
function deriveTitleFromContent(content) {
    const firstLine = content.trim().split(/\n/)[0] ?? '';
    return firstLine.slice(0, 80);
}
function mockExtractResult(url) {
    const mockContent = `[mock] 该 URL 的页面正文（USE_MOCK_TOOLS=1）。\n\n原 URL: ${url}`;
    return {
        success: true,
        data: {
            url,
            title: `[mock] 页面标题`,
            content: mockContent,
            truncated: false,
        },
    };
}
