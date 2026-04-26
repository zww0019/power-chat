// agent 轨迹区块（M4 / 文档 §4.3）。
// 接受 message.agentTrace 序列，按 thought / action+observation / final 分行渲染。
//
// 行为约定（R015 / 文档 §4.4）：
// - 实时进行中：默认展开，新 step 流入；右上角中断按钮（M5 接通真实中断 API，M4 仅 disabled UI）
// - 跑完：状态从 streaming → complete 边沿触发自动折叠成单行汇总（与 reasoningContent 边沿触发同源）
// - 长 thought：>60 字默认省略，点开看完整
// - 失败 step：✕ + #A32D2D 暗红色，与正常 step 视觉清晰区分

import { useState, useRef, useEffect } from 'react';
import type { AgentStep, AgentFinalReason, ToolName } from '../types';

interface Props {
  trace: AgentStep[];
  isStreaming: boolean;
  // M5 起：节点 id 用于中断 API 调用；M4 阶段为 undefined 时按钮 disabled（向后兼容兜底）
  nodeId?: string;
  // M5 起：用户点击中断时调用；调用方负责调 api.abortStream(nodeId)
  onAbort?: (nodeId: string) => void;
}

export function AgentTrace({ trace, isStreaming, nodeId, onAbort }: Props) {
  const [expanded, setExpanded] = useState(true);
  // streaming → complete 边沿触发自动折叠（与 ReasoningBlock 同模式）：
  // useEffect 重跑前 prevStreamingRef.current 已是上次的 isStreaming；本次先读 wasStreaming
  // 再立即赋值为最新 isStreaming，使"streaming→complete"只在那一次 effect 满足
  // wasStreaming=true && !isStreaming，之后无论 effect 是否重跑都不会再触发。
  // 用户手动展开（complete 阶段 toggle expanded）不进入此 effect 依赖，永不触发自动折叠。
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
      // 把后续紧跟的 observation 配对合并到同一行（按 toolCallId 匹配）
      const obs = findObservationFor(trace, i, step.toolCallId);
      rendered.push(<ActionLine key={step.id} action={step} observation={obs} />);
    } else if (step.type === 'observation') {
      // 通常已被 action 行吸收；只在异常缺失对应 action 时单独渲染
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
      <span style={dotIcon}>●</span>
      <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>
        <span style={labelStyle}>Thought：</span>
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
      <span style={failed ? failIcon : arrowIcon}>{failed ? '✕' : '→'}</span>
      <span style={{ flex: 1 }}>
        {actionDesc}
        <span style={{ margin: '0 6px', color: '#cbd5e1' }}>→</span>
        <span style={{ color: failed ? '#A32D2D' : '#475569' }}>{obsDesc}</span>
      </span>
    </div>
  );
}

function OrphanObservationLine({ observation }: { observation: Extract<AgentStep, { type: 'observation' }> }) {
  const failed = !observation.success;
  const desc = failed
    ? `失败（${observation.errorReason ?? 'unknown'}）`
    : observation.result ?? '已完成';
  return (
    <div style={lineStyle}>
      <span style={failed ? failIcon : arrowIcon}>{failed ? '✕' : '→'}</span>
      <span style={{ flex: 1, color: failed ? '#A32D2D' : '#475569' }}>{desc}</span>
    </div>
  );
}

function FinalLine({ reason }: { reason: AgentFinalReason }) {
  return (
    <div style={lineStyle}>
      <span style={dotIcon}>●</span>
      <span style={{ flex: 1 }}>
        <span style={labelStyle}>Thought：</span>
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
      ▸ AI {summary}（展开 ↓）
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

// ============== 中断按钮（M4 视觉就位 / M5 接通行为）==============

function AbortButton({ enabled, onAbort }: { enabled: boolean; onAbort: () => void }) {
  // R015 落地（M5 撤销 M4 临时豁免）：流式期间始终可点。
  // 仅当调用方未传 nodeId/onAbort（极少见的兜底）时按钮回退 disabled
  return (
    <button
      // onPointerDown stopPropagation：阻止事件在 capture 阶段被拖拽层捕获并调用
      // setPointerCapture，否则后续 pointermove 会被节点拖拽消费（视觉规范 §"拖拽与 setPointerCapture"）
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (enabled) onAbort();
      }}
      disabled={!enabled}
      title={enabled ? '中断当前任务' : '中断功能尚未就绪'}
      style={enabled ? abortBtnStyleEnabled : abortBtnStyle}
      aria-label="中断当前任务"
    >
      ⨯
    </button>
  );
}

function CollapseButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} style={collapseLinkBtn} aria-label="折叠">
      ▾ 折叠
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

// ============== 样式（R013 token 对齐：11px 字号档 / text-secondary）==============

const containerStyle: React.CSSProperties = {
  background: '#F5F4EE',
  borderRadius: 6,
  padding: '10px 12px',
  fontSize: 11,
  color: '#94a3b8',
  marginBottom: 4,
  position: 'relative',
  maxWidth: '94%',
  lineHeight: 1.6,
};

const lineStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  marginBottom: 6,
  alignItems: 'flex-start',
};

const dotIcon: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 8,
  lineHeight: '18px',
  width: 12,
  textAlign: 'center',
  flexShrink: 0,
};

const arrowIcon: React.CSSProperties = {
  color: '#94a3b8',
  width: 12,
  textAlign: 'center',
  flexShrink: 0,
};

const failIcon: React.CSSProperties = {
  color: '#A32D2D',
  width: 12,
  textAlign: 'center',
  flexShrink: 0,
  fontWeight: 500,
};

const labelStyle: React.CSSProperties = {
  fontWeight: 500,
  color: '#475569',
  marginRight: 4,
};

const inlineLinkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#6366f1',
  fontSize: 11,
  padding: 0,
  marginLeft: 4,
  cursor: 'pointer',
  textDecoration: 'underline',
};

const collapseLinkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#94a3b8',
  fontSize: 11,
  padding: '2px 0',
  cursor: 'pointer',
  marginTop: 2,
};

const collapsedSummaryBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#475569',
  fontSize: 11,
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left',
  width: '100%',
};

const abortBtnStyle: React.CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 8,
  background: 'transparent',
  border: 'none',
  color: '#cbd5e1',
  cursor: 'not-allowed',
  fontSize: 13,
  padding: 0,
  width: 18,
  height: 18,
  lineHeight: '18px',
};

// 启用态：cursor pointer + 颜色加深 + hover 反馈（CSS 内联无 hover，靠颜色对比表达"可点"）
const abortBtnStyleEnabled: React.CSSProperties = {
  ...abortBtnStyle,
  color: '#475569',
  cursor: 'pointer',
};
