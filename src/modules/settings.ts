// settings-module
// 持有 Settings 单例。INV-9 提供 isConfigured 守卫。
// MVP：apiKey 存明文（与 db.json 一起，被 .gitignore 排除）。Stage 7 切 OS keychain。

import type { Settings, SettingsProvider } from '../types.js';
import { getPersistence } from './persistence.js';

const DEFAULT_SETTINGS: Settings = {
  llmBaseUrl: '',
  llmModel: '',
  llmFastModel: '',
  llmApiKey: '',
  tavilyApiKey: '',
  thinkingModeEnabled: false,
  // 思考强度三档；不同 provider 的 reasoning 字段格式由 llm-client.buildOpenAIRequestBody 翻译
  thinkingEffort: 'medium',
  // provider 路由 enum：默认 custom，旧 db.json 升级路径会按 baseURL 启发式推断
  provider: 'custom',
  privacyAcknowledged: false,
};

// 由 baseURL 启发式推断 provider；仅 stored 缺字段或 baseURL 变更时使用
function inferProviderFromBaseUrl(baseUrl: string | undefined): SettingsProvider {
  const url = (baseUrl || '').toLowerCase();
  if (!url) return 'custom';
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('deepseek.com')) return 'deepseek';
  if (url.includes('api.openai.com')) return 'openai';
  return 'custom';
}

export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '•••••';
  return `${key.slice(0, 3)}•••${key.slice(-4)}`;
}

export async function getSettings(): Promise<Settings> {
  const stored = await getPersistence().getSingleton<Settings>();
  if (!stored) return { ...DEFAULT_SETTINGS };
  // 兼容旧持久化数据缺字段：与默认值合并；provider 缺失时按 baseURL 启发式推断
  const merged: Settings = { ...DEFAULT_SETTINGS, ...stored };
  if ((stored as Partial<Settings>).provider === undefined) {
    merged.provider = inferProviderFromBaseUrl(stored.llmBaseUrl);
  }
  return merged;
}

// 对外的 GET 响应：所有 apiKey 类敏感字段脱敏（D004 / R009 治理）
export async function getSettingsMasked(): Promise<Settings> {
  const s = await getSettings();
  return {
    ...s,
    llmApiKey: maskApiKey(s.llmApiKey),
    tavilyApiKey: maskApiKey(s.tavilyApiKey),
  };
}

export async function putSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const merged: Settings = { ...current, ...patch };
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
export async function isConfigured(): Promise<boolean> {
  const s = await getSettings();
  return !!(s.llmBaseUrl && s.llmModel && s.llmApiKey);
}

export interface PingResult {
  ok: boolean;
  modelsAvailable: string[];
  error?: string;
}

// D001 决策：调 baseURL + /v1/models 测连通
export async function testConnection(): Promise<PingResult> {
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
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return { ok: true, modelsAvailable: (data.data ?? []).map((m) => m.id).slice(0, 50) };
  } catch (e: any) {
    return { ok: false, modelsAvailable: [], error: e.message ?? String(e) };
  }
}
