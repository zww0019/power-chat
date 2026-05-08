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
    const onEscapeKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onEscapeKey);
    return () => window.removeEventListener('keydown', onEscapeKey);
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
          <li><b>建节点</b>：双击画布空白处；画布为空时也可点中央「新建节点」按钮</li>
          <li><b>平移</b>：拖动画布背景，或直接滚轮</li>
          <li><b>缩放</b>：<Kbd>Cmd</Kbd> / <Kbd>Ctrl</Kbd> + 滚轮，或 macOS 双指捏合（25% – 200%）</li>
          <li><b>多选</b>：<Kbd>Shift</Kbd> + 单击节点</li>
          <li><b>提炼</b>：选中多个节点 → 点顶部「提炼」按钮，弹窗中可输入聚焦问题（留空则综合性提炼）。提炼节点底部有「继续追问」按钮，可基于提炼结果孵化新的对话子节点（直接进入大屏）</li>
          <li><b>撰写</b>：选中多个节点 → 点顶部「撰写」按钮，可填写写作要求（留空则综合撰写）</li>
          <li><b>全部折叠 / 全部展开</b>：右上角工具栏一键切换所有节点形态</li>
          <li><b>小地图</b>：右下角 minimap，单击跳转 / 拖动视口框平移</li>
        </ul>
      </Section>

      <Section title="对话操作">
        <ul style={listStyle}>
          <li><b>发送 / 换行</b>：<Kbd>Enter</Kbd> 发送，<Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> 换行</li>
          <li><b>编辑消息</b>：悬浮在自己的消息上 → 点 ✎ 修改后提交，自动重新生成 AI 回复（AI 回复中或消息已被分支引用时不可编辑）</li>
          <li><b>复制 AI 回复</b>：悬浮在 AI 消息上 → 点复制按钮，复制含 Markdown 格式的完整回复</li>
          <li><b>分支</b>：AI 消息悬浮工具栏点「从这里分支」，新节点继承父链上下文</li>
          <li><b>分支双向跳转</b>：子节点顶部横幅可跳回父节点对应消息；AI 消息上的「N 个分支」徽章可展开列表跳到各子节点</li>
        </ul>
      </Section>

      <Section title="节点三态">
        <ul style={listStyle}>
          <li><b>展开</b>：默认形态，完整对话 + 输入框</li>
          <li><b>折叠</b>：点节点 header 上的折叠按钮收起为标题卡片；单击折叠卡片即可重新展开</li>
          <li><b>大屏</b>：点 ⛶ 进入沉浸对话形态，支持完整对话操作；<Kbd>Esc</Kbd> / 点遮罩 / 点 × 退出</li>
          <li><b>标题重新生成</b>：悬浮在节点标题旁点 ↻ 手动触发；每 3 轮对话系统也会自动更新</li>
        </ul>
      </Section>

      <Section title="Agent 联网与思考">
        <ul style={listStyle}>
          <li><b>Agent 联网</b>：在设置中填入 Tavily API Key 后启用。AI 默认不联网；用动作动词（如「搜一下 / 查一下 / 帮我找 / 读一下这个网页」）明确表达需求时才会调用工具</li>
          <li><b>步骤轨迹</b>：Agent 过程以可折叠的步骤区块展示（思考 / 工具调用 / 结果）；运行中可点中断按钮随时终止</li>
          <li><b>思考模式</b>：在设置中开启后，AI 回复前展示可折叠的思考过程区块</li>
          <li><b>思考强度</b>：低 / 中 / 高三档可选（仅 OpenRouter 时有效）</li>
        </ul>
      </Section>

      <Section title="键盘快捷键">
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: space.s5, rowGap: space.s2 }}>
          <ShortcutRow keys={['Enter']} desc="发送消息（节点输入框内）" />
          <ShortcutRow keys={['Shift', 'Enter']} desc="换行（节点输入框内）" />
          <ShortcutRow keys={['Delete']} desc="删除选中边或活跃节点（流式中禁止，会有提示）" />
          <ShortcutRow keys={['Backspace']} desc="同 Delete" />
          <ShortcutRow keys={['⌘/Ctrl', 'Z']} desc="撤销节点移动 / 删除（深度 50，仅当前会话）" />
          <ShortcutRow keys={['Esc']} desc="关闭大屏 / 关闭帮助" />
        </div>
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
