import { useState, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { color, text, space, radius, shadow, font, motion } from '../styles/theme';

export interface ModalShellProps {
  icon: ReactNode;
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  maxHeight?: string;
  zIndex?: number;
}

// 弹窗外壳：fixed 半透明遮罩 + 居中暖色卡片 + 头部 chip 图标 + 标题 + 关闭按钮。
// 点击遮罩或关闭按钮触发 onClose；卡片本体阻止冒泡，保持 modal 行为。
export function ModalShell({
  icon,
  title,
  onClose,
  children,
  width = 540,
  maxHeight = '88vh',
  zIndex = 300,
}: ModalShellProps) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(42, 40, 32, 0.42)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        zIndex,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: font.sans,
        animation: `overlay-in ${motion.durBase}ms ${motion.easeOutSoft}`,
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width,
          maxWidth: '92vw',
          maxHeight,
          overflowY: 'auto',
          background: color.paper,
          borderRadius: radius.xl,
          border: `0.5px solid ${color.ink200}`,
          boxShadow: shadow.xl,
          padding: `${space.s6}px ${space.s7}px ${space.s5}px`,
          color: color.ink900,
          fontSize: text.sm,
          animation: `modal-in ${motion.durBase}ms ${motion.easeOutSoft}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: space.s5 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: radius.md,
              background: color.warm,
              color: color.accent600,
            }}
          >
            {icon}
          </span>
          <span style={{ fontSize: text.lg, fontWeight: 700, letterSpacing: '-0.01em' }}>
            {title}
          </span>
          <span style={{ flex: 1 }} />
          <CloseButton onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

export interface IconButtonProps {
  children: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  title?: string;
  disabled?: boolean;
  size?: number;
  hoverBg?: string;
}

// size 默认 32（弹窗用）；Node header 用 28；NodeFullscreenModal header 用 34。
export function IconButton({
  children,
  onClick,
  onPointerDown,
  title,
  disabled,
  size = 32,
  hoverBg = color.ink100,
}: IconButtonProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onPointerDown={onPointerDown}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      disabled={disabled}
      style={{
        background: hover && !disabled ? hoverBg : 'transparent',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? color.ink300 : color.ink600,
        width: size,
        height: size,
        borderRadius: radius.md,
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

// 关闭按钮：固定 lucide X 图标的 IconButton 特化。size 可调以适配 header 高度。
export function CloseButton({ onClick, size = 32 }: { onClick: () => void; size?: number }) {
  return (
    <IconButton onClick={onClick} title="关闭" size={size}>
      <X size={size <= 30 ? 17 : 18} strokeWidth={1.8} />
    </IconButton>
  );
}

export interface DialogButtonProps {
  variant: 'primary' | 'secondary';
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}

// 弹窗内的主/次按钮：primary 焦糖渐变 + accent shadow，secondary 暖白 + ink 边。
// hover 加深底色；disabled 半透明 + not-allowed。
export function DialogButton({ variant, onClick, disabled, children }: DialogButtonProps) {
  const [hover, setHover] = useState(false);
  const primary = variant === 'primary';
  const baseStyle: CSSProperties = primary
    ? {
        background: hover && !disabled ? color.accent600 : color.accent500,
        color: '#FFFFFF',
        border: 'none',
        boxShadow: disabled ? 'none' : shadow.accent,
      }
    : {
        background: hover && !disabled ? color.ink100 : color.raised,
        color: color.ink700,
        border: `0.5px solid ${color.ink200}`,
      };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...baseStyle,
        padding: '9px 18px',
        borderRadius: radius.md,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: text.sm,
        fontWeight: 600,
        letterSpacing: '-0.005em',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {children}
    </button>
  );
}
