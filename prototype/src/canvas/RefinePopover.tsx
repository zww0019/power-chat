import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useCanvasStore } from '../store/canvasStore';
import { api } from '../api/client';
import { applyStreamEvent } from './nodeActions';
import { color, text, space, radius, shadow, font, motion } from '../styles/theme';
import { DialogButton } from './_dialogPrimitives';

interface Props {
  selectedNodeIds: string[];
  position: { x: number; y: number };
  onClose: () => void;
}

// 提炼对话框（PRD §4.3：popover 不是 modal）
export function RefinePopover({ selectedNodeIds, position, onClose }: Props) {
  const upsertNode = useCanvasStore((s) => s.upsertNode);
  const upsertEdge = useCanvasStore((s) => s.upsertEdge);
  const upsertMessage = useCanvasStore((s) => s.upsertMessage);
  const markMessageError = useCanvasStore((s) => s.markMessageError);
  const setActiveNode = useCanvasStore((s) => s.setActiveNode);
  const setStreaming = useCanvasStore((s) => s.setStreaming);
  const clearSelection = useCanvasStore((s) => s.clearSelection);

  const [intent, setIntent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState(false);

  const handleRefine = async () => {
    if (submitting) return;
    setSubmitting(true);
    // 在 try 外声明，让 catch 分支也能访问 → 网络异常时把卡死状态翻回 idle
    let createdNodeId: string | null = null;
    let createdMsgId: string | null = null;
    try {
      const { node: refinedNode, edges, streamUrl } = await api.refine({
        sourceNodeIds: selectedNodeIds,
        intentQuestion: intent.trim() || null,
      });
      upsertNode(refinedNode);
      edges.forEach(upsertEdge);

      const msgId = `m_${Math.random().toString(36).slice(2, 11)}`;
      createdNodeId = refinedNode.id;
      createdMsgId = msgId;
      upsertMessage({
        id: msgId,
        nodeId: refinedNode.id,
        role: 'assistant',
        content: '',
        reasoningContent: '',
        sequence: 0,
        status: 'streaming',
        createdAt: new Date().toISOString(),
      });
      setStreaming(refinedNode.id, 'streaming');
      setActiveNode(refinedNode.id);
      clearSelection();
      onClose();

      // 用统一的 applyStreamEvent 处理流：补齐 error / reasoning_details，并在 done 事件
      // 把乐观 msgId 替换为后端真实 ID（与 conversation 路径 commit eb844bb 对齐），
      // 修复"提炼出错时节点永久卡在 streaming 状态"的根因。
      await api.streamRefine(streamUrl, (evt) => applyStreamEvent(evt, msgId));
      setStreaming(refinedNode.id, 'idle');
    } catch (e) {
      console.error('refine failed', e);
      // 网络异常 / fetch 抛错路径：必须翻回 streaming 状态并把消息标记 error，
      // 否则 SSE 流根本没起来，applyStreamEvent 不会被触发，节点永久卡在"提炼中"。
      if (createdNodeId) setStreaming(createdNodeId, 'idle');
      if (createdMsgId) markMessageError(createdMsgId, (e as Error).message ?? String(e));
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
        background: color.paper,
        border: `0.5px solid ${color.accent200}`,
        borderRadius: radius.lg,
        padding: space.s5,
        boxShadow: shadow.lg,
        width: 380,
        zIndex: 1000,
        fontFamily: font.sans,
        animation: `modal-in ${motion.durFast}ms ${motion.easeOutSoft}`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: text.md,
          fontWeight: 700,
          color: color.ink900,
          letterSpacing: '-0.01em',
          marginBottom: space.s2,
        }}
      >
        <Sparkles size={16} strokeWidth={1.8} color={color.accent500} />
        提炼 {selectedNodeIds.length} 个节点
      </div>
      <div style={{ fontSize: text.sm, color: color.ink500, marginBottom: space.s3, lineHeight: 1.6 }}>
        这次提炼要回答什么问题？（可选）
      </div>
      <textarea
        value={intent}
        onChange={(e) => setIntent(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="留空表示综合性提炼"
        rows={3}
        style={{
          width: '100%',
          fontSize: text.sm,
          padding: `${space.s2}px ${space.s3}px`,
          border: `0.5px solid ${focused ? color.accent400 : color.ink300}`,
          borderRadius: radius.md,
          resize: 'none',
          fontFamily: 'inherit',
          outline: 'none',
          boxSizing: 'border-box',
          lineHeight: 1.65,
          background: color.raised,
          color: color.ink900,
          boxShadow: focused ? `0 0 0 3px ${color.accent50}` : 'none',
          transition: `border-color ${motion.durFast}ms ${motion.easeInOut}, box-shadow ${motion.durFast}ms ${motion.easeInOut}`,
        }}
        autoFocus
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: space.s2, marginTop: space.s4 }}>
        <DialogButton variant="secondary" onClick={onClose} disabled={submitting}>
          取消
        </DialogButton>
        <DialogButton variant="primary" onClick={handleRefine} disabled={submitting}>
          {submitting ? '提炼中…' : '开始提炼'}
        </DialogButton>
      </div>
    </div>
  );
}
