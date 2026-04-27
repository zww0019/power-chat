import { memo, useMemo, type CSSProperties, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { color, text, space, radius, font } from '../styles/theme';

interface MarkdownContentProps {
  content: string;
  isStreaming: boolean;
}

// 流式期间闭合未完成的内联标记，避免 react-markdown 把半成品当纯文本渲染导致样式抖动。
function closeOpenMarkdown(text: string): string {
  let out = text;

  const fenceCount = (out.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) out += '\n```';

  const inlineCodeCount = (out.replace(/```[\s\S]*?```/g, '').match(/`/g) || []).length;
  if (inlineCodeCount % 2 === 1) out += '`';

  const boldCount = (out.match(/\*\*/g) || []).length;
  if (boldCount % 2 === 1) out += '**';

  const stripped = out.replace(/\*\*/g, '');
  const italicCount = (stripped.match(/(?<![\w*])\*(?![\s*])/g) || []).length;
  if (italicCount % 2 === 1) out += '*';

  return out;
}

function isSafeHref(href: string | undefined): boolean {
  if (!href) return false;
  return /^(https?:|mailto:)/i.test(href);
}

function isSafeImgSrc(src: string | undefined): boolean {
  if (!src) return false;
  return /^(https?:|data:image\/)/i.test(src);
}

const codeBlockStyle: CSSProperties = {
  background: color.ink50,
  border: `0.5px solid ${color.ink200}`,
  borderRadius: radius.sm,
  padding: `${space.s3}px ${space.s4}px`,
  margin: `${space.s2}px 0`,
  overflowX: 'auto',
  fontSize: 13,
  lineHeight: 1.6,
  fontFamily: font.mono,
  color: color.ink800,
};

const inlineCodeStyle: CSSProperties = {
  background: color.accent50,
  border: `0.5px solid ${color.accent100}`,
  borderRadius: 4,
  padding: '1px 5px',
  fontSize: '0.92em',
  fontFamily: font.mono,
  color: color.accent700,
};

const components: Components = {
  a: ({ href, children, ...rest }) =>
    isSafeHref(href) ? (
      <a
        {...rest}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: color.accent600,
          textDecoration: 'underline',
          textDecorationColor: color.accent200,
          textUnderlineOffset: 2,
        }}
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),

  img: ({ src, alt }) =>
    isSafeImgSrc(typeof src === 'string' ? src : undefined) ? (
      <img src={src as string} alt={alt ?? ''} style={{ maxWidth: '100%', height: 'auto', borderRadius: radius.sm }} />
    ) : null,

  pre: ({ children }) => <pre style={codeBlockStyle}>{children}</pre>,
  code: ({ className, children }) => {
    const isFenced = typeof className === 'string' && className.startsWith('language-');
    if (isFenced) return <code className={className}>{children}</code>;
    return <code style={inlineCodeStyle}>{children}</code>;
  },

  h1: ({ children }) => <h1 style={{ fontSize: text.lg, fontWeight: 700, margin: `${space.s3}px 0 ${space.s2}px`, letterSpacing: '-0.01em' }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ fontSize: text.md, fontWeight: 700, margin: `${space.s3}px 0 ${space.s2}px`, letterSpacing: '-0.01em' }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: text.base, fontWeight: 600, margin: `${space.s2}px 0 ${space.s1}px` }}>{children}</h3>,
  h4: ({ children }) => <h4 style={{ fontSize: text.base, fontWeight: 600, margin: `${space.s2}px 0 ${space.s1}px` }}>{children}</h4>,
  h5: ({ children }) => <h5 style={{ fontSize: text.sm, fontWeight: 600, margin: `${space.s2}px 0 ${space.s1}px` }}>{children}</h5>,
  h6: ({ children }) => <h6 style={{ fontSize: text.sm, fontWeight: 600, margin: `${space.s2}px 0 ${space.s1}px` }}>{children}</h6>,

  p: ({ children }) => <p style={{ margin: `${space.s1}px 0` }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin: `${space.s1}px 0`, paddingLeft: 22 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: `${space.s1}px 0`, paddingLeft: 22 }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: '3px 0' }}>{children}</li>,

  blockquote: ({ children }) => (
    <blockquote
      style={{
        borderLeft: `3px solid ${color.accent300}`,
        margin: `${space.s2}px 0`,
        padding: `2px ${space.s3}px`,
        color: color.ink600,
        background: 'rgba(250, 241, 228, 0.4)',
        borderRadius: '0 4px 4px 0',
      }}
    >
      {children}
    </blockquote>
  ),

  table: ({ children }: { children?: ReactNode }) => (
    <div style={{ overflowX: 'auto', maxWidth: '100%', margin: `${space.s2}px 0` }}>
      <table style={{ borderCollapse: 'collapse', fontSize: text.sm }}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th style={{ border: `0.5px solid ${color.ink200}`, padding: '6px 10px', background: color.ink50, textAlign: 'left', fontWeight: 600 }}>
      {children}
    </th>
  ),
  td: ({ children }) => <td style={{ border: `0.5px solid ${color.ink200}`, padding: '6px 10px' }}>{children}</td>,

  hr: () => <hr style={{ border: 'none', borderTop: `0.5px solid ${color.ink200}`, margin: `${space.s3}px 0` }} />,
};

function MarkdownContentImpl({ content, isStreaming }: MarkdownContentProps) {
  const safeContent = useMemo(
    () => (isStreaming ? closeOpenMarkdown(content) : content),
    [content, isStreaming],
  );
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {safeContent}
    </ReactMarkdown>
  );
}

export const MarkdownContent = memo(MarkdownContentImpl);
