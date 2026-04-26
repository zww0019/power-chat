import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Settings } from '../types';

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
}

interface TestResult {
  status: 'idle' | 'testing' | 'ok' | 'error';
  message?: string;
  models: string[];
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

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
  });
  const [maskedKey, setMaskedKey] = useState(''); // 仅展示用（llmApiKey）
  const [maskedTavilyKey, setMaskedTavilyKey] = useState(''); // 仅展示用（tavilyApiKey）
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
          llmApiKey: '', // 表单 value 留空，脱敏值仅作 placeholder
          tavilyApiKey: '', // 同上，避免脱敏字符串覆写真值（D004）
          thinkingModeEnabled: !!s.thinkingModeEnabled,
        });
        setMaskedKey(s.llmApiKey ?? '');
        setMaskedTavilyKey(s.tavilyApiKey ?? '');
      })
      .catch((e) => setLoadError(`读取设置失败：${e.message ?? e}`));
  }, [open]);

  if (!open) return null;

  const canTest = !!form.llmBaseUrl;

  // 提交语义：apiKey / tavilyApiKey 仅在 dirty 时才发送，避免脱敏字符串覆盖真值（D004）
  function buildPatch(): Partial<Settings> {
    const patch: Partial<Settings> = {
      llmBaseUrl: form.llmBaseUrl,
      llmModel: form.llmModel,
      llmFastModel: form.llmFastModel,
      thinkingModeEnabled: form.thinkingModeEnabled,
    };
    if (apiKeyDirty) patch.llmApiKey = form.llmApiKey;
    if (tavilyKeyDirty) patch.tavilyApiKey = form.tavilyApiKey;
    return patch;
  }

  const handleTest = async () => {
    if (!canTest) return;
    setTest({ status: 'testing', models: [] });
    try {
      // 先把当前表单（含 apiKey 若 dirty）保存到 server，让 testConnection 用最新配置
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
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: FONT,
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 480,
          maxWidth: '92vw',
          background: '#ffffff',
          borderRadius: 10,
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.18)',
          padding: '20px 24px',
          color: '#1e293b',
          fontSize: 13,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>⚙ 模型设置</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={closeBtn} title="关闭">×</button>
        </div>

        {loadError && <div style={errorBox}>{loadError}</div>}

        <Field label="Base URL" hint="OpenAI 兼容协议的服务根地址，例如 https://api.deepseek.com/v1">
          <input
            value={form.llmBaseUrl}
            onChange={(e) => setForm({ ...form, llmBaseUrl: e.target.value })}
            placeholder="https://api.deepseek.com/v1"
            style={input}
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
            style={input}
          />
        </Field>

        <Field label="Model" hint="主模型，用于对话和提炼。点击下方「测试连接」可拉取可用模型列表">
          <input
            list="models-datalist"
            value={form.llmModel}
            onChange={(e) => setForm({ ...form, llmModel: e.target.value })}
            placeholder="例如 deepseek-reasoner"
            style={input}
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
            style={input}
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
            style={input}
          />
        </Field>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.thinkingModeEnabled}
            onChange={(e) => setForm({ ...form, thinkingModeEnabled: e.target.checked })}
          />
          <span>启用思考模式（流式中显示模型 reasoning 内容）</span>
        </label>

        {/* 测试连接结果 */}
        <div style={{ marginTop: 8, marginBottom: 4, minHeight: 22, fontSize: 12 }}>
          {test.status === 'testing' && <span style={{ color: '#94a3b8' }}>正在测试连接…</span>}
          {test.status === 'ok' && <span style={{ color: '#16a34a' }}>✓ {test.message}</span>}
          {test.status === 'error' && <span style={{ color: '#dc2626' }}>✗ {test.message}</span>}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button
            onClick={handleTest}
            disabled={!canTest || test.status === 'testing' || saving}
            style={{ ...secondaryBtn, opacity: canTest ? 1 : 0.5 }}
          >
            测试连接
          </button>
          <button onClick={onClose} style={secondaryBtn} disabled={saving}>取消</button>
          <button onClick={handleSave} style={primaryBtn} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: '#475569', marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

const input: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  border: '1px solid #cbd5e1',
  borderRadius: 5,
  fontSize: 13,
  fontFamily: FONT,
  outline: 'none',
  boxSizing: 'border-box',
};

const primaryBtn: React.CSSProperties = {
  background: '#6366f1',
  color: '#ffffff',
  border: 'none',
  padding: '7px 16px',
  borderRadius: 5,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
};

const secondaryBtn: React.CSSProperties = {
  background: '#f1f5f9',
  color: '#475569',
  border: '1px solid #e2e8f0',
  padding: '7px 14px',
  borderRadius: 5,
  cursor: 'pointer',
  fontSize: 13,
};

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  fontSize: 18,
  color: '#94a3b8',
  cursor: 'pointer',
  padding: '0 4px',
};

const errorBox: React.CSSProperties = {
  background: '#fef2f2',
  border: '1px solid #fecaca',
  color: '#b91c1c',
  padding: '8px 10px',
  borderRadius: 5,
  fontSize: 12,
  marginBottom: 10,
};
