// Design token TS 镜像 —— 与 tokens.css 对齐，给 inline style 直接消费。
// 单一事实源是 tokens.css；这里仅做映射，色值/数值若改动需同步两边。

export const color = {
  canvas: '#F1EFE8',
  paper: '#FBF9F2',
  raised: '#FFFFFF',
  warm: '#F5E9D2',
  warmHi: '#EFDDB8',
  soft: '#F5F2E8',
  tint: '#FAF1E4',

  ink50: '#FAF9F4',
  ink100: '#F1EFE8',
  ink200: '#E5E2D5',
  ink300: '#CFCBBC',
  ink400: '#A8A395',
  ink500: '#7C7867',
  ink600: '#5C5849',
  ink700: '#3E3B30',
  ink800: '#2A2820',
  ink900: '#1A1813',

  accent50: '#FAF1E4',
  accent100: '#F2DFBE',
  accent200: '#E6C695',
  accent300: '#DBA876',
  accent400: '#C99055',
  accent500: '#B8783A',
  accent600: '#9A6128',
  accent700: '#7A4C1E',

  moss300: '#8FA286',
  moss500: '#5C7556',
  moss600: '#455B40',

  success: '#5C7556',
  warning: '#C9882F',
  danger: '#B85040',
  info: '#B8783A',
} as const;

export const text = {
  xs: 12,
  sm: 13,
  base: 15,
  md: 16,
  lg: 18,
  xl: 22,
} as const;

export const leading = {
  tight: 1.4,
  snug: 1.55,
  base: 1.7,
  loose: 1.8,
} as const;

export const space = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s7: 32,
  s8: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 9999,
} as const;

export const shadow = {
  sm: '0 1px 2px rgba(60, 48, 28, 0.05)',
  md: '0 2px 8px rgba(60, 48, 28, 0.08), 0 1px 3px rgba(60, 48, 28, 0.04)',
  lg: '0 6px 20px rgba(60, 48, 28, 0.10), 0 2px 6px rgba(60, 48, 28, 0.04)',
  xl: '0 16px 40px rgba(60, 48, 28, 0.14), 0 4px 12px rgba(60, 48, 28, 0.06)',
  inset: 'inset 0 0 0 0.5px rgba(60, 48, 28, 0.08)',
  accent: '0 4px 14px rgba(184, 120, 58, 0.22)',
} as const;

export const font = {
  sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Inter", "Noto Sans SC", "Helvetica Neue", "Hiragino Sans GB", sans-serif',
  serif: '"Iowan Old Style", "Apple Garamond", "Songti SC", "Source Han Serif SC", Georgia, serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
} as const;

export const motion = {
  easeOutExpo: 'cubic-bezier(0.16, 1, 0.3, 1)',
  easeOutSoft: 'cubic-bezier(0.32, 0.72, 0, 1)',
  easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
  durFast: 140,
  durBase: 200,
  durSlow: 280,
} as const;
