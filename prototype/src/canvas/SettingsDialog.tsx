import { useEffect, useState } from 'react';
import { Settings as SettingsIcon, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../api/client';
import type { Settings, SettingsProvider, ThinkingEffort } from '../types';
import { color, text, space, radius, font, motion } from '../styles/theme';
import { ModalShell, DialogButton } from './_dialogPrimitives';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface FormState {
  llmBaseUrl: string;
  llmModel: string;
  llmFastModel: string;
  llmApiKey: string;
  tavilyApiKey: string;
  thinkingModeEnabled: boolean;
  thinkingEffort: ThinkingEffort;
  provider: SettingsProvider;
}

const PROVIDER_OPTIONS: { value: SettingsProvider; label: string }[] = [
  { value: 'openrouter', label: 'OpenRouter（聚合各家模型）' },
  { value: 'openai', label: 'OpenAI（o-series 推理模型）' },
  { value: 'deepseek', label: 'DeepSeek（R1 系列）' },
  { value: 'custom', label: 'Custom（自建中转 / 其他）' },
];

const EFFORT_OPTIONS: { value: ThinkingEffort; label: string; hint: string }[] = [
  { value: 'low', label: '低', hint: '约 20% token 用于思考' },
  { value: 'medium', label: '中', hint: '约 50% token 用于思考（默认）' },
  { value: 'high', label: '高', hint: '约 80% token 用于思考' },
];

interface TestResult {
  status: 'idle' | 'testing' | 'ok' | 'error';
  message?: string;
  models: string[];
}

// 配置 LLM 的设置弹窗。
// 关键约束：apiKey 字段从后端拿到的是脱敏值（如 sk-•••abc1）。
// 用户没动 apiKey 时，提交不能把脱敏字符串写回 server——通过 dirty flag 控制。
export function SettingsDialog({ open, onClose }: Props) {
  const [form, setForm] = useState<FormState>({
    llmBaseUrl: '',
    llmModel: '',
    llmFastModel: '',
    llmApiKey: '',
    tavilyApiKey: '',
    thinkingModeEnabled: false,
    thinkingEffort: 'medium',
    provider: 'custom',
  });
  const [maskedKey, setMaskedKey] = useState('');
  const [maskedTavilyKey, setMaskedTavilyKey] = useState('');
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [tavilyKeyDirty, setTavilyKeyDirty] = useState(false);
  const [test, setTest] = useState<TestResult>({ status: 'idle', models: [] });
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoadError(null);
    setApiKeyDirty(false);
    setTavilyKeyDirty(false);
    setTest({ status: 'idle', models: [] });
    api.getSettings()
      .then((s) => {
        setForm({
          llmBaseUrl: s.llmBaseUrl ?? '',
          llmModel: s.llmModel ?? '',
          llmFastModel: s.llmFastModel ?? '',
          llmApiKey: '',
          tavilyApiKey: '',
          thinkingModeEnabled: !!s.thinkingModeEnabled,
          // 旧 db.json 缺字段时后端 getSettings 已按 baseURL 推断 + 兜底，前端直接信任返回值
          thinkingEffort: (s.thinkingEffort ?? 'medium') as ThinkingEffort,
          provider: (s.provider ?? 'custom') as SettingsProvider,
        });
        setMaskedKey(s.llmApiKey ?? '');
        setMaskedTavilyKey(s.tavilyApiKey ?? '');
      })
      .catch((e) => setLoadError(`读取设置失败：${e.message ?? e}`));
  }, [open]);

  if (!open) return null;

  const canTest = !!form.llmBaseUrl;

  function buildPatch(): Partial<Settings> {
    const patch: Partial<Settings> = {
      llmBaseUrl: form.llmBaseUrl,
      llmModel: form.llmModel,
      llmFastModel: form.llmFastModel,
      thinkingModeEnabled: form.thinkingModeEnabled,
      thinkingEffort: form.thinkingEffort,
      provider: form.provider,
    };
    if (apiKeyDirty) patch.llmApiKey = form.llmApiKey;
    if (tavilyKeyDirty) patch.tavilyApiKey = form.tavilyApiKey;
    return patch;
  }

  const handleTest = async () => {
    if (!canTest) return;
    setTest({ status: 'testing', models: [] });
    try {
      await api.putSettings(buildPatch());
      const result = await api.testConnection();
      if (result.ok) {
        setTest({ status: 'ok', models: result.modelsAvailable, message: `已连通，${result.modelsAvailable.length} 个模型可用` });
      } else {
        setTest({ status: 'error', models: [], message: result.error ?? '未知错误' });
      }
    } catch (e: any) {
      setTest({ status: 'error', models: [], message: e.message ?? String(e) });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.putSettings(buildPatch());
      onClose();
    } catch (e: any) {
      alert(`保存失败：${e.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      icon={<SettingsIcon size={17} strokeWidth={1.8} />}
      title="模型设置"
      onClose={onClose}
      width={540}
      zIndex={1000}
    >
      {loadError && <div style={errorBox}>{loadError}</div>}

      <Field label="Provider" hint="决定 reasoning 字段格式与多轮思考连续性策略。OpenRouter 聚合模型请选 OpenRouter；自建中转选 Custom 走兼容路径">
        <select
          value={form.provider}
          onChange={(e) => setForm({ ...form, provider: e.target.value as SettingsProvider })}
          style={inputStyle}
        >
          {PROVIDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </Field>

      <Field label="Base URL" hint="OpenAI 兼容协议的服务根地址，例如 https://api.deepseek.com/v1">
        <input
          value={form.llmBaseUrl}
          onChange={(e) => setForm({ ...form, llmBaseUrl: e.target.value })}
          placeholder="https://api.deepseek.com/v1"
          style={inputStyle}
        />
      </Field>

      <Field label="API Key" hint="存储在本地 .data/db.json，不会上传到任何服务">
        <input
          type="password"
          value={form.llmApiKey}
          onChange={(e) => {
            setForm({ ...form, llmApiKey: e.target.value });
            setApiKeyDirty(true);
          }}
          placeholder={maskedKey ? `当前：${maskedKey}（留空保持不变）` : '输入 API Key'}
          style={inputStyle}
        />
      </Field>

      <Field label="Model" hint="主模型，用于对话和提炼。点击下方「测试连接」可拉取可用模型列表">
        <input
          list="models-datalist"
          value={form.llmModel}
          onChange={(e) => setForm({ ...form, llmModel: e.target.value })}
          placeholder="例如 deepseek-reasoner"
          style={inputStyle}
        />
        {test.models.length > 0 && (
          <datalist id="models-datalist">
            {test.models.map((m) => <option key={m} value={m} />)}
          </datalist>
        )}
      </Field>

      <Field label="Fast Model" hint="可选。用于节点标题等高频轻量调用，留空则回退主模型">
        <input
          list="models-datalist"
          value={form.llmFastModel}
          onChange={(e) => setForm({ ...form, llmFastModel: e.target.value })}
          placeholder="例如 deepseek-chat（留空使用主模型）"
          style={inputStyle}
        />
      </Field>

      <Field label="Tavily API Key" hint="可选。用于 agent 模式下的网络搜索与网页读取（web_search / fetch_page 工具）。在 tavily.com 注册免费档可用">
        <input
          type="password"
          value={form.tavilyApiKey}
          onChange={(e) => {
            setForm({ ...form, tavilyApiKey: e.target.value });
            setTavilyKeyDirty(true);
          }}
          placeholder={maskedTavilyKey ? `当前：${maskedTavilyKey}（留空保持不变）` : '输入 Tavily API Key（可选）'}
          style={inputStyle}
        />
      </Field>

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: `${space.s3}px 0`, cursor: 'pointer', fontSize: text.sm }}>
        <input
          type="checkbox"
          checked={form.thinkingModeEnabled}
          onChange={(e) => setForm({ ...form, thinkingModeEnabled: e.target.checked })}
          style={{ width: 16, height: 16, accentColor: color.accent500 }}
        />
        <span style={{ color: color.ink800 }}>启用思考模式（流式中显示模型 reasoning 内容）</span>
      </label>

      {form.thinkingModeEnabled && (
        <div style={{ paddingLeft: 26, marginBottom: space.s3 }}>
          <div style={{ fontSize: text.xs, color: color.ink500, marginBottom: 6 }}>思考强度</div>
          <div style={{ display: 'flex', gap: space.s2 }}>
            {EFFORT_OPTIONS.map((opt) => {
              const active = form.thinkingEffort === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setForm({ ...form, thinkingEffort: opt.value })}
                  title={opt.hint}
                  style={{
                    padding: '6px 14px',
                    borderRadius: radius.md,
                    border: `0.5px solid ${active ? color.accent500 : color.ink300}`,
                    background: active ? color.accent500 : color.raised,
                    color: active ? '#fff' : color.ink800,
                    fontSize: text.sm,
                    fontFamily: font.sans,
                    cursor: 'pointer',
                    transition: `background ${motion.durFast}ms ${motion.easeInOut}, border-color ${motion.durFast}ms ${motion.easeInOut}`,
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 测试连接结果 */}
      <div style={{ marginTop: space.s2, marginBottom: space.s2, minHeight: 24, fontSize: text.sm }}>
        {test.status === 'testing' && (
          <span style={{ color: color.ink500, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-flex', animation: 'spin 1s linear infinite' }}>
              <Loader2 size={14} strokeWidth={2} />
            </span>
            正在测试连接…
          </span>
        )}
        {test.status === 'ok' && (
          <span style={{ color: color.success, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <CheckCircle2 size={14} strokeWidth={2} />
            {test.message}
          </span>
        )}
        {test.status === 'error' && (
          <span style={{ color: color.danger, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <AlertCircle size={14} strokeWidth={2} />
            {test.message}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: space.s2, marginTop: space.s4, justifyContent: 'flex-end' }}>
        <DialogButton
          variant="secondary"
          onClick={handleTest}
          disabled={!canTest || test.status === 'testing' || saving}
        >
          测试连接
        </DialogButton>
        <DialogButton variant="secondary" onClick={onClose} disabled={saving}>
          取消
        </DialogButton>
        <DialogButton variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </DialogButton>
      </div>
    </ModalShell>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div style={{ marginBottom: space.s4 }}>
      <div style={{ fontSize: text.sm, fontWeight: 600, color: color.ink800, marginBottom: space.s2, letterSpacing: '-0.005em' }}>
        {label}
      </div>
      {children}
      {hint && <div style={{ fontSize: text.xs, color: color.ink500, marginTop: 6, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: `0.5px solid ${color.ink300}`,
  borderRadius: radius.md,
  fontSize: text.sm,
  fontFamily: font.sans,
  outline: 'none',
  boxSizing: 'border-box',
  background: color.raised,
  color: color.ink900,
  transition: `border-color ${motion.durFast}ms ${motion.easeInOut}, box-shadow ${motion.durFast}ms ${motion.easeInOut}`,
};

const errorBox: React.CSSProperties = {
  background: 'rgba(184, 80, 64, 0.08)',
  border: `0.5px solid rgba(184, 80, 64, 0.32)`,
  color: color.danger,
  padding: `${space.s2}px ${space.s3}px`,
  borderRadius: radius.md,
  fontSize: text.sm,
  marginBottom: space.s3,
};
