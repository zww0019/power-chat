// agent 轨迹区块（M4 / 文档 §4.3）。
// 接受 message.agentTrace 序列，按 thought / action+observation / final 分行渲染。
//
// 行为约定（R015 / 文档 §4.4）：
// - 实时进行中：默认展开，新 step 流入；右上角中断按钮
// - 跑完：状态从 streaming → complete 边沿触发自动折叠成单行汇总
// - 长 thought：>60 字默认省略，点开看完整
// - 失败 step：✕ + 暖红色，与正常 step 视觉清晰区分

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, ChevronRight, X, Search, Globe, Hammer } from 'lucide-react';
import type { AgentStep, AgentFinalReason, ToolName } from '../types';
import { color, text, space, radius } from '../styles/theme';

interface Props {
  trace: AgentStep[];
  isStreaming: boolean;
  nodeId?: string;
  onAbort?: (nodeId: string) => void;
}

export function AgentTrace({ trace, isStreaming, nodeId, onAbort }: Props) {
  const [expanded, setExpanded] = useState(true);
  const prevStreamingRef = useRef(isStreaming);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (wasStreaming && !isStreaming) setExpanded(false);
  }, [isStreaming]);

  if (trace.length === 0) return null;

  const canAbort = isStreaming && !!nodeId && !!onAbort;
  const handleAbort = () => {
    if (canAbort) onAbort!(nodeId!);
  };

  return (
    <div style={containerStyle}>
      {isStreaming && <AbortButton enabled={canAbort} onAbort={handleAbort} />}
      {expanded ? (
        <ExpandedTrace trace={trace} onCollapse={() => setExpanded(false)} />
      ) : (
        <CollapsedSummary trace={trace} onExpand={() => setExpanded(true)} />
      )}
    </div>
  );
}

// ============== 展开态：逐 step 渲染 ==============

function ExpandedTrace({ trace, onCollapse }: { trace: AgentStep[]; onCollapse: () => void }) {
  const rendered: React.ReactNode[] = [];
  for (let i = 0; i < trace.length; i++) {
    const step = trace[i]!;
    if (step.type === 'thought') {
      rendered.push(<ThoughtLine key={step.id} content={step.content} />);
    } else if (step.type === 'action') {
      const obs = findObservationFor(trace, i, step.toolCallId);
      rendered.push(<ActionLine key={step.id} action={step} observation={obs} />);
    } else if (step.type === 'observation') {
      const orphan = !trace.slice(0, i).some(
        (s) => s.type === 'action' && s.toolCallId === step.toolCallId,
      );
      if (orphan) rendered.push(<OrphanObservationLine key={step.id} observation={step} />);
    } else if (step.type === 'final') {
      rendered.push(<FinalLine key={step.id} reason={step.reason} />);
    }
  }
  return (
    <div>
      {rendered}
      <CollapseButton onClick={onCollapse} />
    </div>
  );
}

function findObservationFor(
  trace: AgentStep[],
  fromIndex: number,
  toolCallId: string,
): Extract<AgentStep, { type: 'observation' }> | undefined {
  for (let i = fromIndex + 1; i < trace.length; i++) {
    const s = trace[i]!;
    if (s.type === 'observation' && s.toolCallId === toolCallId) return s;
  }
  return undefined;
}

// ============== 各类 step 行 ==============

function ThoughtLine({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const isTruncatable = content.length > 60;
  const display = !isTruncatable || open ? content : `${content.slice(0, 60)}…`;
  return (
    <div style={lineStyle}>
      <span style={iconSlot}><span style={dot} /></span>
      <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>
        <span style={labelStyle}>Thought</span>
        {display}
        {isTruncatable && !open && (
          <button onClick={() => setOpen(true)} style={inlineLinkBtn}>展开</button>
        )}
      </span>
    </div>
  );
}

interface ActionLineProps {
  action: Extract<AgentStep, { type: 'action' }>;
  observation: Extract<AgentStep, { type: 'observation' }> | undefined;
}

function ActionLine({ action, observation }: ActionLineProps) {
  const failed = !!observation && !observation.success;
  const actionDesc = describeAction(action.toolName, action.toolArgs);
  const obsDesc = !observation
    ? '…'
    : observation.success
      ? observation.result ?? '已完成'
      : `失败（${observation.errorReason ?? 'unknown'}）`;
  return (
    <div style={lineStyle}>
      <span style={iconSlot}>
        {failed ? (
          <X size={11} strokeWidth={2.2} color={color.danger} />
        ) : (
          <ToolIcon toolName={action.toolName} />
        )}
      </span>
      <span style={{ flex: 1 }}>
        <span style={{ color: color.ink700 }}>{actionDesc}</span>
        <span style={{ margin: '0 6px', color: color.ink300 }}>→</span>
        <span style={{ color: failed ? color.danger : color.ink600 }}>{obsDesc}</span>
      </span>
    </div>
  );
}

function ToolIcon({ toolName }: { toolName: ToolName | string }) {
  if (toolName === 'web_search') return <Search size={11} strokeWidth={2} color={color.accent500} />;
  if (toolName === 'fetch_page') return <Globe size={11} strokeWidth={2} color={color.accent500} />;
  return <Hammer size={11} strokeWidth={2} color={color.accent500} />;
}

function OrphanObservationLine({ observation }: { observation: Extract<AgentStep, { type: 'observation' }> }) {
  const failed = !observation.success;
  const desc = failed
    ? `失败（${observation.errorReason ?? 'unknown'}）`
    : observation.result ?? '已完成';
  return (
    <div style={lineStyle}>
      <span style={iconSlot}>
        {failed ? <X size={11} strokeWidth={2.2} color={color.danger} /> : <span style={dot} />}
      </span>
      <span style={{ flex: 1, color: failed ? color.danger : color.ink600 }}>{desc}</span>
    </div>
  );
}

function FinalLine({ reason }: { reason: AgentFinalReason }) {
  return (
    <div style={lineStyle}>
      <span style={iconSlot}><span style={{ ...dot, background: color.moss500 }} /></span>
      <span style={{ flex: 1 }}>
        <span style={labelStyle}>Final</span>
        {describeFinalReason(reason)}
      </span>
    </div>
  );
}

// ============== 折叠态：单行汇总 ==============

function CollapsedSummary({ trace, onExpand }: { trace: AgentStep[]; onExpand: () => void }) {
  const summary = buildSummary(trace);
  return (
    <button onClick={onExpand} style={collapsedSummaryBtn}>
      <ChevronRight size={12} strokeWidth={2} />
      <span style={{ flex: 1 }}>AI {summary}</span>
      <span style={{ color: color.ink400, fontSize: text.xs }}>展开</span>
    </button>
  );
}

function buildSummary(trace: AgentStep[]): string {
  let searchCount = 0;
  let fetchCount = 0;
  for (const s of trace) {
    if (s.type !== 'action') continue;
    if (s.toolName === 'web_search') searchCount++;
    else if (s.toolName === 'fetch_page') fetchCount++;
  }
  const parts: string[] = [];
  if (searchCount > 0) parts.push(`搜索 ${searchCount} 次`);
  if (fetchCount > 0) parts.push(`阅读 ${fetchCount} 个网页`);
  if (parts.length === 0) return '已完成思考';
  return parts.join(' / ');
}

// ============== 中断按钮 ==============

function AbortButton({ enabled, onAbort }: { enabled: boolean; onAbort: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (enabled) onAbort();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={!enabled}
      title={enabled ? '中断当前任务' : '中断功能尚未就绪'}
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        background: enabled && hover ? color.danger : 'transparent',
        border: `0.5px solid ${enabled ? color.danger : color.ink300}`,
        color: enabled && hover ? '#fff' : (enabled ? color.danger : color.ink300),
        cursor: enabled ? 'pointer' : 'not-allowed',
        fontSize: text.xs,
        padding: 0,
        width: 22,
        height: 22,
        borderRadius: radius.pill,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      aria-label="中断当前任务"
    >
      <X size={12} strokeWidth={2} />
    </button>
  );
}

function CollapseButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} style={collapseLinkBtn} aria-label="折叠">
      <ChevronDown size={12} strokeWidth={2} />
      折叠
    </button>
  );
}

// ============== 文案与展示工具函数 ==============

function describeAction(toolName: ToolName | string, args: Record<string, unknown>): string {
  if (toolName === 'web_search') {
    const q = typeof args.query === 'string' ? args.query : '';
    return `搜索 "${q.length > 30 ? q.slice(0, 30) + '…' : q}"`;
  }
  if (toolName === 'fetch_page') {
    const url = typeof args.url === 'string' ? args.url : '';
    return `读取 ${url.length > 40 ? url.slice(0, 40) + '…' : url}`;
  }
  return `调用 ${toolName}`;
}

function describeFinalReason(reason: AgentFinalReason): string {
  switch (reason) {
    case 'completed': return '信息已足够，开始整理回复';
    case 'max_steps': return '已达单次任务步数上限，基于已有信息回复';
    case 'max_same_tool': return '已多次调用同种工具，基于已有信息回复';
    case 'max_time': return '已达单次任务时间上限，基于已有信息回复';
    case 'aborted_by_user': return '已被用户中断';
    case 'aborted_by_new_message': return '用户输入新消息，已中断当前任务';
    case 'tool_error_fatal': return '工具调用持续失败，无法继续';
    default: return '已结束';
  }
}

// ============== 样式 ==============

const containerStyle: React.CSSProperties = {
  background: 'rgba(245, 233, 210, 0.5)',
  border: `0.5px solid ${color.accent200}`,
  borderRadius: radius.md,
  padding: `${space.s3}px ${space.s4}px`,
  fontSize: text.xs,
  color: color.ink600,
  marginBottom: space.s2,
  position: 'relative',
  maxWidth: '94%',
  lineHeight: 1.7,
};

const lineStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginBottom: 5,
  alignItems: 'flex-start',
};

const iconSlot: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 14,
  height: 18,
  flexShrink: 0,
};

const dot: React.CSSProperties = {
  display: 'inline-block',
  width: 5,
  height: 5,
  borderRadius: '50%',
  background: color.accent500,
};

const labelStyle: React.CSSProperties = {
  fontWeight: 600,
  color: color.accent700,
  marginRight: 6,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const inlineLinkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: color.accent600,
  fontSize: text.xs,
  padding: 0,
  marginLeft: 4,
  cursor: 'pointer',
  textDecoration: 'underline',
  fontWeight: 500,
};

const collapseLinkBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: 'transparent',
  border: 'none',
  color: color.ink500,
  fontSize: text.xs,
  padding: '4px 0 0',
  cursor: 'pointer',
  marginTop: 2,
};

const collapsedSummaryBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: 'transparent',
  border: 'none',
  color: color.ink700,
  fontSize: text.xs,
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left',
  width: '100%',
  fontWeight: 500,
};
