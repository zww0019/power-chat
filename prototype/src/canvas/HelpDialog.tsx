import { useEffect } from 'react';
import { HelpCircle } from 'lucide-react';
import { color, text, space, font } from '../styles/theme';
import { ModalShell } from './_dialogPrimitives';

// 帮助弹窗：静态文档展示，无业务逻辑。
// ESC 同时关闭 fullscreen 与 help（用户合理预期"一键全清"）。

interface HelpDialogProps {
  onClose: () => void;
}

export function HelpDialog({ onClose }: HelpDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <ModalShell
      icon={<HelpCircle size={17} strokeWidth={1.8} />}
      title="帮助"
      onClose={onClose}
      width={540}
      maxHeight="82vh"
      zIndex={300}
    >
      <Section title="关于">
        <div style={{ color: color.ink600, lineHeight: 1.75 }}>
          <strong style={{ color: color.ink900 }}>思考画布</strong> — 为深度思考而设计的安静工具。
          <br />
          把零散对话编织成可探索的思维网络。
        </div>
      </Section>

      <Section title="核心操作">
        <ul style={listStyle}>
          <li><b>建节点</b>：双击画布空白处</li>
          <li><b>平移</b>：拖动画布背景，或直接滚轮</li>
          <li><b>缩放</b>：<Kbd>Cmd</Kbd> / <Kbd>Ctrl</Kbd> + 滚轮</li>
          <li><b>多选</b>：<Kbd>Shift</Kbd> + 单击节点</li>
          <li><b>提炼</b>：选中多个节点 → 点击顶部「提炼」按钮，汇总成新节点</li>
          <li><b>分支</b>：AI 回复消息旁点击「从这里分支」，新节点继承父链上下文</li>
          <li><b>小地图</b>：右下角 minimap，单击跳转 / 拖动视口框平移</li>
        </ul>
      </Section>

      <Section title="键盘快捷键">
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: space.s5, rowGap: space.s2 }}>
          <ShortcutRow keys={['Enter']} desc="发送消息（节点输入框内）" />
          <ShortcutRow keys={['Shift', 'Enter']} desc="换行（节点输入框内）" />
          <ShortcutRow keys={['Delete']} desc="删除选中边或活跃节点" />
          <ShortcutRow keys={['⌘/Ctrl', 'Z']} desc="撤销节点移动 / 删除（深度 50，仅当前会话）" />
          <ShortcutRow keys={['Esc']} desc="关闭大屏 / 关闭帮助" />
        </div>
      </Section>

      <Section title="节点三态">
        <ul style={listStyle}>
          <li><b>展开</b>：默认形态，完整对话 + 输入框</li>
          <li><b>折叠</b>：点击节点 header 上的折叠按钮收起为标题卡片，节省空间</li>
          <li><b>大屏</b>：点击全屏按钮进入沉浸阅读形态，<Kbd>Esc</Kbd> 退出</li>
        </ul>
      </Section>
    </ModalShell>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div style={{ marginBottom: space.s5 }}>
      <div
        style={{
          fontSize: text.xs,
          fontWeight: 600,
          color: color.accent600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: space.s2,
        }}
      >
        {title}
      </div>
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
            {i < keys.length - 1 && <span style={{ color: color.ink400, fontSize: text.xs }}>+</span>}
          </span>
        ))}
      </div>
      <div style={{ color: color.ink700 }}>{desc}</div>
    </>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <span style={kbdStyle}>{children}</span>;
}

const listStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: space.s5,
  color: color.ink700,
  lineHeight: 1.85,
};

const kbdStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  background: color.raised,
  border: `0.5px solid ${color.ink200}`,
  borderBottom: `1.5px solid ${color.ink200}`,
  borderRadius: 5,
  padding: '2px 7px',
  fontSize: text.xs,
  fontFamily: font.mono,
  color: color.ink800,
  fontWeight: 500,
  lineHeight: 1.4,
  boxShadow: 'inset 0 -1px 0 rgba(60, 48, 28, 0.04)',
};
