import { memo, useMemo, type CSSProperties, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  content: string;
  isStreaming: boolean;
}

// 流式期间闭合未完成的内联标记，避免 react-markdown 把半成品当纯文本渲染导致样式抖动。
// 仅做最浅层闭合：粗体 ** / 斜体 * / 行内 ` / 代码块 ```。不做嵌套结构分析。
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

// http(s) / mailto 之外的协议一律拦下，防 prompt injection 带入恶意链接
function isSafeHref(href: string | undefined): boolean {
  if (!href) return false;
  return /^(https?:|mailto:)/i.test(href);
}

// data:image 额外放行，允许 LLM 输出 base64 图片；其余非 http(s) 协议同样拦截
function isSafeImgSrc(src: string | undefined): boolean {
  if (!src) return false;
  return /^(https?:|data:image\/)/i.test(src);
}

const codeBlockStyle: CSSProperties = {
  background: '#f1f5f9',
  border: '1px solid #e2e8f0',
  borderRadius: 4,
  padding: '8px 10px',
  margin: '6px 0',
  overflowX: 'auto',
  fontSize: 12,
  lineHeight: 1.5,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
};

const inlineCodeStyle: CSSProperties = {
  background: '#f1f5f9',
  borderRadius: 3,
  padding: '1px 4px',
  fontSize: 12,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
};

// 模块级常量：react-markdown 每次渲染时若 components 引用变化会触发全量子树重渲染，
// 定义在模块顶层保证引用稳定，避免 memo 失效
const components: Components = {
  a: ({ href, children, ...rest }) =>
    isSafeHref(href) ? (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#185FA5' }}>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),

  img: ({ src, alt }) =>
    isSafeImgSrc(typeof src === 'string' ? src : undefined) ? (
      <img src={src as string} alt={alt ?? ''} style={{ maxWidth: '100%', height: 'auto', borderRadius: 4 }} />
    ) : null,

  pre: ({ children }) => <pre style={codeBlockStyle}>{children}</pre>,
  code: ({ className, children }) => {
    // 围栏代码块由 pre 提供容器，code 仅承担文本；行内 code 走自己样式
    const isFenced = typeof className === 'string' && className.startsWith('language-');
    if (isFenced) return <code className={className}>{children}</code>;
    return <code style={inlineCodeStyle}>{children}</code>;
  },

  h1: ({ children }) => <h1 style={{ fontSize: 15, fontWeight: 600, margin: '8px 0 4px' }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ fontSize: 14, fontWeight: 600, margin: '8px 0 4px' }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 4px' }}>{children}</h3>,
  h4: ({ children }) => <h4 style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 4px' }}>{children}</h4>,
  h5: ({ children }) => <h5 style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 4px' }}>{children}</h5>,
  h6: ({ children }) => <h6 style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 4px' }}>{children}</h6>,

  p: ({ children }) => <p style={{ margin: '4px 0' }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin: '4px 0', paddingLeft: 20 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '4px 0', paddingLeft: 20 }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,

  blockquote: ({ children }) => (
    <blockquote style={{ borderLeft: '3px solid #cbd5e1', margin: '4px 0', padding: '2px 8px', color: '#475569' }}>
      {children}
    </blockquote>
  ),

  // 节点卡片宽度有限，宽表格滑动展示而非撑破
  table: ({ children }: { children?: ReactNode }) => (
    <div style={{ overflowX: 'auto', maxWidth: '100%', margin: '6px 0' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th style={{ border: '1px solid #e2e8f0', padding: '4px 8px', background: '#f8fafc', textAlign: 'left' }}>
      {children}
    </th>
  ),
  td: ({ children }) => <td style={{ border: '1px solid #e2e8f0', padding: '4px 8px' }}>{children}</td>,

  hr: () => <hr style={{ border: 'none', borderTop: '1px solid #e2e8f0', margin: '8px 0' }} />,
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
