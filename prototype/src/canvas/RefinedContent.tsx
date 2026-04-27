import type { Message } from '../types';
import { color, text, space } from '../styles/theme';

interface RefinedContentProps {
  message: Message | null;
}

// R011 / D008 · 按四栏 marker 切分提炼输出。marker 缺失时单独提示，全失败则兜底原文。
const SECTIONS = [
  { marker: '【核心结论】', label: '核心结论' },
  { marker: '【关键论据】', label: '关键论据' },
  { marker: '【未解决 / 待验证】', label: '未解决 / 待验证' },
  { marker: '【可能的下一步】', label: '可能的下一步' },
] as const;

interface ParsedSection {
  label: string;
  body: string;
  found: boolean;
}

function parseRefinedText(text: string): ParsedSection[] {
  const positions = SECTIONS
    .map((s) => ({ ...s, pos: text.indexOf(s.marker) }))
    .filter((p) => p.pos !== -1)
    .sort((a, b) => a.pos - b.pos);

  return SECTIONS.map((s) => {
    const hit = positions.find((p) => p.label === s.label);
    if (!hit) return { label: s.label, body: '', found: false };
    const startBody = hit.pos + s.marker.length;
    const next = positions.find((p) => p.pos > hit.pos);
    const endBody = next ? next.pos : text.length;
    return { label: s.label, body: text.slice(startBody, endBody).trim(), found: true };
  });
}

export function RefinedContent({ message }: RefinedContentProps) {
  if (!message) {
    return <div style={emptyStyle}>提炼输出将在这里显示…</div>;
  }
  const isStreaming = message.status === 'streaming';
  const sections = parseRefinedText(message.content);
  const noneFound = sections.every((s) => !s.found);

  // 兜底：marker 完全识别失败（流式刚开始或 LLM 完全跑偏）→ 显示原文
  if (noneFound) {
    return (
      <div style={fallbackBox}>
        {message.content
          ? <>
              <div style={hintLine}>格式未识别，显示原文：</div>
              <div style={rawText}>
                {message.content}
                {isStreaming && <span style={cursor}>▍</span>}
              </div>
            </>
          : <div style={emptyStyle}>提炼输出将在这里显示…</div>
        }
      </div>
    );
  }

  return (
    <div style={{ padding: `${space.s4}px ${space.s5}px` }}>
      {sections.map((s, idx) => {
        const isLast = idx === sections.length - 1;
        return (
          <div
            key={s.label}
            style={{
              marginBottom: isLast ? 0 : space.s4,
              paddingBottom: isLast ? 0 : space.s4,
              borderBottom: isLast ? 'none' : `0.5px solid ${color.accent200}`,
            }}
          >
            <div style={sectionLabel}>{s.label}</div>
            {s.found ? (
              <div style={sectionBody}>
                {s.body || (isStreaming ? '…' : '（空）')}
              </div>
            ) : (
              <div style={hintLine}>（此栏未输出，可能是 LLM 格式漂移）</div>
            )}
          </div>
        );
      })}
      {isStreaming && (
        <div
          style={{
            fontSize: text.xs,
            color: color.accent600,
            marginTop: space.s3,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: color.accent500,
              animation: 'blink 1.4s ease-in-out infinite',
            }}
          />
          提炼中…
        </div>
      )}
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  padding: `${space.s4}px ${space.s5}px`,
  fontSize: text.sm,
  fontStyle: 'italic',
  color: color.ink400,
};

const fallbackBox: React.CSSProperties = {
  padding: `${space.s4}px ${space.s5}px`,
  fontSize: text.base,
  lineHeight: 1.7,
  color: color.accent700,
};

const rawText: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  marginTop: 4,
};

const sectionLabel: React.CSSProperties = {
  fontSize: text.xs,
  fontWeight: 600,
  color: color.accent600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  marginBottom: space.s2,
};

const sectionBody: React.CSSProperties = {
  fontSize: text.base,
  lineHeight: 1.75,
  color: color.ink900,
  whiteSpace: 'pre-wrap',
};

const hintLine: React.CSSProperties = {
  fontSize: text.xs,
  color: color.accent500,
  fontStyle: 'italic',
};

const cursor: React.CSSProperties = {
  color: color.accent500,
  marginLeft: 2,
};

