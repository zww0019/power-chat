import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useCanvasStore } from '../store/canvasStore';
import { api } from '../api/client';
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
  const appendMessageContent = useCanvasStore((s) => s.appendMessageContent);
  const finalizeMessage = useCanvasStore((s) => s.finalizeMessage);
  const setActiveNode = useCanvasStore((s) => s.setActiveNode);
  const setStreaming = useCanvasStore((s) => s.setStreaming);
  const clearSelection = useCanvasStore((s) => s.clearSelection);

  const [intent, setIntent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState(false);

  const handleRefine = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const { node: refinedNode, edges, streamUrl } = await api.refine({
        sourceNodeIds: selectedNodeIds,
        intentQuestion: intent.trim() || null,
      });
      upsertNode(refinedNode);
      edges.forEach(upsertEdge);

      const msgId = `m_${Math.random().toString(36).slice(2, 11)}`;
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

      await api.streamRefine(streamUrl, (evt) => {
        if (evt.type === 'reasoning') appendMessageContent(msgId, '', evt.delta);
        else if (evt.type === 'content') appendMessageContent(msgId, evt.delta);
        else if (evt.type === 'done') finalizeMessage(msgId);
      });
      setStreaming(refinedNode.id, 'idle');
    } catch (e) {
      console.error('refine failed', e);
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
