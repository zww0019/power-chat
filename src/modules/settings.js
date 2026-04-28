// settings-module
// 持有 Settings 单例。INV-9 提供 isConfigured 守卫。
// MVP：apiKey 存明文（与 db.json 一起，被 .gitignore 排除）。Stage 7 切 OS keychain。
import { getPersistence } from './persistence.js';
const DEFAULT_SETTINGS = {
    llmBaseUrl: '',
    llmModel: '',
    llmFastModel: '',
    llmApiKey: '',
    tavilyApiKey: '',
    thinkingModeEnabled: false,
    // 新增（OpenRouter 兼容改造）：思考强度三档；不同 provider 的 reasoning 字段格式不同，
    // 由 llm-client.buildOpenAIRequestBody 按 provider 分支翻译此值
    thinkingEffort: 'medium',
    // 新增：provider 路由 enum；驱动 reasoning 字段格式与历史 reasoning_details 回填策略
    provider: 'custom',
    privacyAcknowledged: false,
};
// 由 baseURL 启发式推断 provider。仅在 stored 缺失 provider 字段时使用——
// 一次性向后兼容，旧 db.json 升级后下次保存会显式写入 provider 字段。
function inferProviderFromBaseUrl(baseUrl) {
    const url = (baseUrl || '').toLowerCase();
    if (!url) return 'custom';
    if (url.includes('openrouter.ai')) return 'openrouter';
    if (url.includes('deepseek.com')) return 'deepseek';
    if (url.includes('api.openai.com')) return 'openai';
    return 'custom';
}
export function maskApiKey(key) {
    if (!key)
        return '';
    if (key.length <= 8)
        return '•••••';
    return `${key.slice(0, 3)}•••${key.slice(-4)}`;
}
export async function getSettings() {
    const stored = await getPersistence().getSingleton();
    if (!stored) return { ...DEFAULT_SETTINGS };
    // 兼容旧持久化数据缺字段：与默认值合并 + 推断 provider（仅在 stored 未显式写入时）
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    if (stored.provider === undefined) {
        merged.provider = inferProviderFromBaseUrl(stored.llmBaseUrl);
    }
    return merged;
}
// 对外的 GET 响应：所有 apiKey 类敏感字段脱敏（D004 / R009 治理）
export async function getSettingsMasked() {
    const s = await getSettings();
    return {
        ...s,
        llmApiKey: maskApiKey(s.llmApiKey),
        tavilyApiKey: maskApiKey(s.tavilyApiKey),
    };
}
export async function putSettings(patch) {
    const current = await getSettings();
    const merged = { ...current, ...patch };
    // baseURL 变更但调用方未显式指定 provider：按新 baseURL 重新推断，
    // 让用户改 URL 后无需手动调 provider 下拉就能命中正确分支
    if (patch.llmBaseUrl !== undefined && patch.provider === undefined && patch.llmBaseUrl !== current.llmBaseUrl) {
        merged.provider = inferProviderFromBaseUrl(patch.llmBaseUrl);
    }
    await getPersistence().putSingleton(merged);
    return {
        ...merged,
        llmApiKey: maskApiKey(merged.llmApiKey),
        tavilyApiKey: maskApiKey(merged.tavilyApiKey),
    };
}
// INV-9：未配置时禁止 LLM 调用
export async function isConfigured() {
    const s = await getSettings();
    return !!(s.llmBaseUrl && s.llmModel && s.llmApiKey);
}
// D001 决策：调 baseURL + /v1/models 测连通
export async function testConnection() {
    const s = await getSettings();
    if (!s.llmBaseUrl) {
        return { ok: false, modelsAvailable: [], error: 'baseURL is empty' };
    }
    // 测试模式：USE_MOCK_LLM 时返回假数据（避免真实网络调用）
    if (process.env.USE_MOCK_LLM === '1') {
        return { ok: true, modelsAvailable: ['mock-model-r1', 'mock-model-base'] };
    }
    try {
        const res = await fetch(`${s.llmBaseUrl.replace(/\/$/, '')}/models`, {
            headers: s.llmApiKey ? { Authorization: `Bearer ${s.llmApiKey}` } : {},
        });
        if (!res.ok) {
            return { ok: false, modelsAvailable: [], error: `HTTP ${res.status}` };
        }
        const data = (await res.json());
        return { ok: true, modelsAvailable: (data.data ?? []).map((m) => m.id).slice(0, 50) };
    }
    catch (e) {
        return { ok: false, modelsAvailable: [], error: e.message ?? String(e) };
    }
}
