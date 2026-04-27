import type { CSSProperties } from 'react';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { useToastStore } from '../store/toastStore';
import { color, text, space, radius, shadow, font, motion } from '../styles/theme';

// 全屏右上角 toast 堆栈。挂在 App 根，不进入画布 transform 层（避免随画布缩放）。
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 80,
        right: 20,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        gap: space.s2,
        pointerEvents: 'none',
        fontFamily: font.sans,
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          style={{ ...toastBaseStyle, pointerEvents: 'auto' }}
          title="点击关闭"
        >
          <span style={accentBarStyles[t.kind]} />
          <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: iconColorFor(t.kind) }}>
            {iconFor(t.kind)}
          </span>
          <span style={{ flex: 1, color: color.ink800 }}>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

const toastBaseStyle: CSSProperties = {
  minWidth: 280,
  maxWidth: 440,
  padding: `${space.s3}px ${space.s4}px ${space.s3}px ${space.s5}px`,
  paddingLeft: 18,
  borderRadius: radius.md,
  border: `0.5px solid ${color.ink200}`,
  background: 'rgba(251, 249, 242, 0.96)',
  backdropFilter: 'blur(20px) saturate(140%)',
  WebkitBackdropFilter: 'blur(20px) saturate(140%)',
  fontSize: text.sm,
  lineHeight: 1.55,
  boxShadow: shadow.lg,
  cursor: 'pointer',
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  position: 'relative',
  overflow: 'hidden',
  animation: `toast-in ${motion.durSlow}ms ${motion.easeOutExpo}`,
};

function makeAccentBar(kindColor: string): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    background: kindColor,
    borderTopLeftRadius: radius.md,
    borderBottomLeftRadius: radius.md,
  };
}

const accentBarStyles: Record<'success' | 'error' | 'info', CSSProperties> = {
  success: makeAccentBar(color.success),
  error: makeAccentBar(color.danger),
  info: makeAccentBar(color.accent500),
};

function iconColorFor(kind: 'success' | 'error' | 'info'): string {
  if (kind === 'success') return color.success;
  if (kind === 'error') return color.danger;
  return color.accent500;
}

function iconFor(kind: 'success' | 'error' | 'info') {
  if (kind === 'success') return <CheckCircle2 size={16} strokeWidth={2} />;
  if (kind === 'error') return <AlertCircle size={16} strokeWidth={2} />;
  return <Info size={16} strokeWidth={2} />;
}
