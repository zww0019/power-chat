import { useEffect } from 'react';

// 帮助弹窗：静态文档展示，无业务逻辑。
// 内容直接 JSX 写死，避免引入 markdown 解析器。
// ESC 同时关闭 fullscreen 与 help（用户合理预期"一键全清"），不做分级。

interface HelpDialogProps {
  onClose: () => void;
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

export function HelpDialog({ onClose }: HelpDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        zIndex: 300,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: FONT,
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 480,
          maxWidth: '92vw',
          maxHeight: '80vh',
          overflowY: 'auto',
          background: '#FFFFFF',
          borderRadius: 8,
          border: '0.5px solid #E5E3DA',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.18)',
          padding: '20px 24px',
          color: '#1e293b',
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: 16, fontWeight: 500 }}>? 帮助</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={closeBtn} title="关闭">
            ×
          </button>
        </div>

        <Section title="关于">
          <div style={{ color: '#475569' }}>
            思考画布 — 为深度思考而设计的安静工具。
            <br />
            把零散对话编织成可探索的思维网络。
          </div>
        </Section>

        <Section title="核心操作">
          <ul style={listStyle}>
            <li>
              <b>建节点</b>：双击画布空白处
            </li>
            <li>
              <b>平移</b>：拖动画布背景，或直接滚轮
            </li>
            <li>
              <b>缩放</b>：<Kbd>Cmd</Kbd> / <Kbd>Ctrl</Kbd> + 滚轮
            </li>
            <li>
              <b>多选</b>：<Kbd>Shift</Kbd> + 单击节点
            </li>
            <li>
              <b>提炼</b>：选中多个节点 → 点击顶部「提炼」按钮，汇总成新节点
            </li>
            <li>
              <b>分支</b>：AI 回复消息旁点击「从这里分支」，新节点继承父链上下文
            </li>
            <li>
              <b>小地图</b>：右下角 minimap，单击跳转 / 拖动视口框平移
            </li>
          </ul>
        </Section>

        <Section title="键盘快捷键">
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 14, rowGap: 8 }}>
            <ShortcutRow keys={['Enter']} desc="发送消息（节点输入框内）" />
            <ShortcutRow keys={['Shift', 'Enter']} desc="换行（节点输入框内）" />
            <ShortcutRow keys={['Delete']} desc="删除选中边或活跃节点" />
            <ShortcutRow keys={['Esc']} desc="关闭大屏 / 关闭帮助" />
          </div>
        </Section>

        <Section title="节点三态">
          <ul style={listStyle}>
            <li>
              <b>展开</b>：默认形态，完整对话 + 输入框
            </li>
            <li>
              <b>折叠</b>：点击节点 header 上的 <Kbd>−</Kbd> 收起为标题卡片，节省空间
            </li>
            <li>
              <b>大屏</b>：点击 <Kbd>⛶</Kbd> 进入沉浸阅读形态，<Kbd>Esc</Kbd> 退出
            </li>
          </ul>
        </Section>
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: '#1e293b', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

interface ShortcutRowProps {
  keys: string[];
  desc: string;
}

function ShortcutRow({ keys, desc }: ShortcutRowProps) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
        {keys.map((k, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Kbd>{k}</Kbd>
            {i < keys.length - 1 && <span style={{ color: '#94a3b8', fontSize: 11 }}>+</span>}
          </span>
        ))}
      </div>
      <div style={{ color: '#475569' }}>{desc}</div>
    </>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <span style={kbdStyle}>{children}</span>;
}

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  fontSize: 18,
  color: '#94a3b8',
  cursor: 'pointer',
  padding: '0 4px',
};

const listStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  color: '#475569',
};

const kbdStyle: React.CSSProperties = {
  display: 'inline-block',
  background: '#F1EFE8',
  border: '0.5px solid #E5E3DA',
  borderRadius: 4,
  padding: '1px 6px',
  fontSize: 11,
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
  color: '#475569',
  lineHeight: 1.4,
};
