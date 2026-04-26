import { useState } from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { api } from '../api/client';

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

      // 创建占位 assistant 消息
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

      // 流式获取提炼结果
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
        background: '#ffffff',
        border: '1px solid #c7d2fe',
        borderRadius: 8,
        padding: 14,
        boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
        width: 360,
        zIndex: 1000,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div style={{ fontSize: 13, fontWeight: 500, color: '#475569', marginBottom: 8 }}>
        提炼 {selectedNodeIds.length} 个节点
      </div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8 }}>
        这次提炼要回答什么问题？(可选)
      </div>
      <textarea
        value={intent}
        onChange={(e) => setIntent(e.target.value)}
        placeholder="留空表示综合性提炼"
        rows={3}
        style={{
          width: '100%',
          fontSize: 13,
          padding: 8,
          border: '1px solid #e2e8f0',
          borderRadius: 4,
          resize: 'none',
          fontFamily: 'inherit',
          outline: 'none',
        }}
        autoFocus
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
        <button onClick={onClose} disabled={submitting} style={btnGhost}>
          取消
        </button>
        <button onClick={handleRefine} disabled={submitting} style={btnPrimary}>
          {submitting ? '提炼中…' : '提炼'}
        </button>
      </div>
    </div>
  );
}

const btnGhost: React.CSSProperties = {
  padding: '6px 14px',
  border: '1px solid #e2e8f0',
  background: '#ffffff',
  color: '#475569',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
};

const btnPrimary: React.CSSProperties = {
  padding: '6px 14px',
  border: 'none',
  background: '#6366f1',
  color: '#ffffff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
};
