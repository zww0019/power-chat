import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Sparkles, Plus, FolderOpen, Pencil, Trash2, HelpCircle, Settings as SettingsIcon } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import { useViewStore } from '../store/viewStore';
import { clearViewport } from '../store/viewportStorage';
import { ModalShell } from '../canvas/_dialogPrimitives';
import { SettingsDialog } from '../canvas/SettingsDialog';
import { HelpDialog } from '../canvas/HelpDialog';
import { api } from '../api/client';
import type { Project } from '../types';
import { color, text, space, radius, shadow, font, motion } from '../styles/theme';

// 项目管理首页：卡片网格 + 最近打开优先排序 + 新建/重命名/删除。
// 用户决策：卡片网格、新建后直接跳转重命名、删除二次确认。

export function HomePage() {
  const projects = useProjectStore((s) => s.projects);
  const loading = useProjectStore((s) => s.loading);
  const error = useProjectStore((s) => s.error);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const createProject = useProjectStore((s) => s.createProject);
  const renameProject = useProjectStore((s) => s.renameProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const touchProject = useProjectStore((s) => s.touchProject);
  const openProject = useViewStore((s) => s.openProject);

  // 决策：新建项目后直接跳转重命名——给一个默认名落库，然后把卡片切到 inline rename 态
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // 全局设置/帮助入口：从画布层级上提到首页，画布页不再持有
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [cognitionStatus, setCognitionStatus] = useState<'unknown' | 'disabled' | 'ok' | 'error'>('unknown');

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // 仅在首次挂载时检测 LLM 配置是否完整；依赖空数组确保只跑一次，
  // 避免 settingsOpen 每次变化都重复检测造成不必要的 getSettings 请求。
  useEffect(() => {
    api.getSettings().then((s) => {
      if (!s.llmBaseUrl || !s.llmModel || !s.llmApiKey) {
        setSettingsOpen(true);
      }
    }).catch((e) => console.error('getSettings failed', e));
  }, []);

  // 探测 cognition 服务连通状态：首次挂载 + 每次 SettingsDialog 关闭后复检。
  // 依赖 settingsOpen 而非空数组：用户在设置里开启/关闭 cognition 后需要立即刷新状态角标；
  // 用 cancelled flag 保证弹窗关闭后旧请求的回调不会覆盖新状态。
  // 注意：setSettingsOpen(false) 会触发本 effect 再次执行，但 getSettings + cognitionHealth
  // 均为幂等只读请求，不会产生副作用，重跑无害。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.getSettings();
        if (cancelled) return;
        if (!s.cognitionEnabled) {
          setCognitionStatus('disabled');
          return;
        }
        const r = await api.cognitionHealth();
        if (cancelled) return;
        setCognitionStatus(r.ok ? 'ok' : 'error');
      } catch {
        if (!cancelled) setCognitionStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [settingsOpen]);

  const handleCreate = async () => {
    try {
      const created = await createProject('未命名项目');
      // 立即进入重命名态：给用户最少的交互步骤完成"创建并命名"
      setRenamingId(created.id);
    } catch (e: any) {
      alert(`新建项目失败：${e?.message ?? e}`);
    }
  };

  const handleOpen = async (proj: Project) => {
    if (renamingId === proj.id) return; // 重命名中不响应卡片点击
    try {
      await touchProject(proj.id);
    } catch {
      // touch 失败仅影响排序，不阻断打开
    }
    openProject(proj.id);
  };

  const handleRenameSubmit = async (id: string, newName: string) => {
    setRenamingId(null);
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      await renameProject(id, trimmed);
    } catch (e: any) {
      alert(`重命名失败：${e?.message ?? e}`);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProject(id);
      clearViewport(id); // 同步清掉该项目的视口持久化数据
    } catch (e: any) {
      alert(`删除失败：${e?.message ?? e}`);
    } finally {
      setConfirmDeleteId(null);
    }
  };

  const confirmTarget = confirmDeleteId
    ? projects.find((p) => p.id === confirmDeleteId) ?? null
    : null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden auto',
        background: color.canvas,
        fontFamily: font.sans,
        color: color.ink900,
      }}
    >
      {/* 顶部 Logo 胶囊：与画布页同款，给用户"还在同一应用内"的连续感 */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          padding: `${space.s5}px ${space.s7}px`,
          background: 'rgba(241, 239, 232, 0.85)',
          backdropFilter: 'blur(20px) saturate(140%)',
          WebkitBackdropFilter: 'blur(20px) saturate(140%)',
          display: 'flex',
          alignItems: 'center',
          gap: space.s3,
          borderBottom: `0.5px solid ${color.ink200}`,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontSize: text.sm,
            fontWeight: 600,
            color: color.ink800,
            letterSpacing: '-0.01em',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              borderRadius: radius.sm,
              background: `linear-gradient(135deg, ${color.accent400}, ${color.accent600})`,
              color: '#FFFFFF',
            }}
          >
            <Sparkles size={13} strokeWidth={2} />
          </span>
          思考画布
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: text.xs, color: color.ink500 }}>
          {projects.length > 0 ? `${projects.length} 个项目` : ''}
        </span>
        <ToolbarIconButton onClick={() => setHelpOpen(true)} title="帮助">
          <HelpCircle size={17} strokeWidth={1.6} />
        </ToolbarIconButton>
        <div style={{ position: 'relative', display: 'inline-flex' }}>
          <ToolbarIconButton
            onClick={() => setSettingsOpen(true)}
            title={
              cognitionStatus === 'ok' ? '模型设置 · 认知建模已连接'
              : cognitionStatus === 'error' ? '模型设置 · 认知建模服务不可达（点开查看）'
              : cognitionStatus === 'disabled' ? '模型设置 · 认知建模已关闭'
              : '模型设置'
            }
          >
            <SettingsIcon size={17} strokeWidth={1.6} />
          </ToolbarIconButton>
          {(cognitionStatus === 'error' || cognitionStatus === 'disabled') && (
            <span
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: cognitionStatus === 'error' ? color.danger : color.ink400,
                pointerEvents: 'none',
              }}
            />
          )}
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: `${space.s7}px ${space.s7}px ${space.s8}px` }}>
        {/* 标题区 */}
        <div style={{ marginBottom: space.s7 }}>
          <div
            style={{
              fontSize: text.xl,
              fontWeight: 700,
              color: color.ink900,
              letterSpacing: '-0.02em',
              marginBottom: 6,
            }}
          >
            我的项目
          </div>
          <div style={{ fontSize: text.sm, color: color.ink500 }}>
            选择项目继续，或新建一个开始
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div
            style={{
              padding: `${space.s3}px ${space.s4}px`,
              background: '#FBE9E7',
              border: `0.5px solid ${color.danger}`,
              borderRadius: radius.md,
              color: color.danger,
              fontSize: text.sm,
              marginBottom: space.s4,
            }}
          >
            加载失败：{error}
          </div>
        )}

        {/* 加载占位 */}
        {loading && projects.length === 0 && (
          <div style={{ color: color.ink500, fontSize: text.sm }}>加载中…</div>
        )}

        {/* 空状态：仅当非加载且列表确实为空时才显示 */}
        {!loading && projects.length === 0 && !error && (
          <EmptyState onCreate={handleCreate} />
        )}

        {/* 卡片网格 */}
        {projects.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: space.s4,
            }}
          >
            {/* 新建卡：放在网格首位，方便随时新建 */}
            <NewProjectCard onClick={handleCreate} />

            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                renaming={renamingId === p.id}
                onOpen={() => handleOpen(p)}
                onRequestRename={() => setRenamingId(p.id)}
                onRenameSubmit={(name) => handleRenameSubmit(p.id, name)}
                onRenameCancel={() => setRenamingId(null)}
                onRequestDelete={() => setConfirmDeleteId(p.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 删除二次确认（用户决策：保持简洁不做软删除） */}
      {confirmTarget && (
        <ModalShell
          icon={<Trash2 size={18} strokeWidth={1.6} />}
          title="确认删除项目"
          onClose={() => setConfirmDeleteId(null)}
          width={460}
        >
          <div style={{ fontSize: text.sm, color: color.ink700, lineHeight: 1.6 }}>
            将永久删除「{confirmTarget.name}」及其所有节点、对话、提炼内容。此操作不可撤销。
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: space.s3, marginTop: space.s5 }}>
            <button
              onClick={() => setConfirmDeleteId(null)}
              style={secondaryBtn}
            >
              取消
            </button>
            <button
              onClick={() => handleDelete(confirmTarget.id)}
              style={dangerBtn}
            >
              删除
            </button>
          </div>
        </ModalShell>
      )}

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

// ---------------- 子组件 ----------------

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      style={{
        marginTop: 80,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: space.s4,
      }}
    >
      <div
        style={{
          width: 88,
          height: 88,
          borderRadius: radius.xl,
          background: `linear-gradient(135deg, ${color.accent100}, ${color.warm})`,
          border: `0.5px solid ${color.accent200}`,
          boxShadow: shadow.lg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: color.accent600,
        }}
      >
        <FolderOpen size={36} strokeWidth={1.4} />
      </div>
      <div>
        <div style={{ fontSize: text.lg, fontWeight: 700, color: color.ink900, letterSpacing: '-0.01em', marginBottom: 6 }}>
          还没有项目
        </div>
        <div style={{ fontSize: text.sm, color: color.ink500, lineHeight: 1.6 }}>
          每个项目是一张独立画布，承载一个主题的思考与对话
        </div>
      </div>
      <button onClick={onCreate} style={primaryBtn}>
        <Plus size={15} strokeWidth={1.8} />
        新建项目
      </button>
    </div>
  );
}

function NewProjectCard({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 160,
        background: hover ? color.warm : color.paper,
        border: `1px dashed ${hover ? color.accent400 : color.ink300}`,
        borderRadius: radius.lg,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        color: hover ? color.accent600 : color.ink500,
        transition: `background ${motion.durFast}ms ${motion.easeInOut}, color ${motion.durFast}ms ${motion.easeInOut}, border ${motion.durFast}ms ${motion.easeInOut}`,
        fontFamily: 'inherit',
      }}
    >
      <Plus size={28} strokeWidth={1.6} />
      <span style={{ fontSize: text.sm, fontWeight: 600, letterSpacing: '-0.01em' }}>新建项目</span>
    </button>
  );
}

interface ProjectCardProps {
  project: Project;
  renaming: boolean;
  onOpen: () => void;
  onRequestRename: () => void;
  onRenameSubmit: (name: string) => void;
  onRenameCancel: () => void;
  onRequestDelete: () => void;
}

function ProjectCard({
  project,
  renaming,
  onOpen,
  onRequestRename,
  onRenameSubmit,
  onRenameCancel,
  onRequestDelete,
}: ProjectCardProps) {
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 进入重命名态后聚焦并选中全部文字，让用户立刻可以覆盖输入
  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  const lastOpenedLabel = formatLastOpened(project.lastOpenedAt, project.createdAt);

  return (
    <div
      onClick={() => !renaming && onOpen()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        height: 160,
        background: color.paper,
        border: `0.5px solid ${color.ink200}`,
        borderRadius: radius.lg,
        boxShadow: hover ? shadow.lg : shadow.sm,
        transform: hover && !renaming ? 'translateY(-2px)' : 'none',
        cursor: renaming ? 'default' : 'pointer',
        padding: space.s4,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transition: `box-shadow ${motion.durFast}ms ${motion.easeInOut}, transform ${motion.durFast}ms ${motion.easeInOut}`,
      }}
    >
      {/* 项目图标 */}
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: radius.md,
          background: `linear-gradient(135deg, ${color.accent100}, ${color.warm})`,
          color: color.accent600,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <FolderOpen size={18} strokeWidth={1.6} />
      </div>

      {/* 项目名 / 重命名输入 */}
      {renaming ? (
        <input
          ref={inputRef}
          defaultValue={project.name}
          maxLength={40}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onRenameSubmit((e.target as HTMLInputElement).value);
            } else if (e.key === 'Escape') {
              onRenameCancel();
            }
          }}
          onBlur={(e) => onRenameSubmit(e.target.value)}
          style={{
            border: `1px solid ${color.accent400}`,
            borderRadius: radius.sm,
            padding: '6px 8px',
            fontSize: text.base,
            fontWeight: 600,
            color: color.ink900,
            background: color.raised,
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
      ) : (
        <div
          style={{
            fontSize: text.base,
            fontWeight: 600,
            color: color.ink900,
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {project.name}
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* 元信息行 */}
      <div style={{ fontSize: text.xs, color: color.ink500 }}>{lastOpenedLabel}</div>

      {/* hover 时显示的操作按钮：右上角 */}
      {!renaming && hover && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            display: 'flex',
            gap: 4,
            background: color.raised,
            border: `0.5px solid ${color.ink200}`,
            borderRadius: radius.pill,
            padding: 3,
            boxShadow: shadow.md,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <CardActionBtn title="重命名" onClick={onRequestRename}>
            <Pencil size={14} strokeWidth={1.7} />
          </CardActionBtn>
          <CardActionBtn title="删除" danger onClick={onRequestDelete}>
            <Trash2 size={14} strokeWidth={1.7} />
          </CardActionBtn>
        </div>
      )}
    </div>
  );
}

// 首页顶部条专用图标按钮（帮助 / 设置入口）。
// 与 CanvasPage 内的同名组件实现相似但各自独立，避免跨页共享导致样式耦合；
// 若未来抽公共组件库，两处可合并。
function ToolbarIconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? color.ink100 : 'transparent',
        border: 'none',
        width: 34,
        height: 34,
        borderRadius: radius.md,
        cursor: 'pointer',
        color: hover ? color.accent600 : color.ink600,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: `background ${motion.durFast}ms ${motion.easeInOut}, color ${motion.durFast}ms ${motion.easeInOut}`,
      }}
    >
      {children}
    </button>
  );
}

function CardActionBtn({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 26,
        height: 26,
        border: 'none',
        borderRadius: '50%',
        background: hover ? (danger ? '#FBE9E7' : color.ink100) : 'transparent',
        color: hover ? (danger ? color.danger : color.accent600) : color.ink500,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: `background ${motion.durFast}ms ${motion.easeInOut}, color ${motion.durFast}ms ${motion.easeInOut}`,
      }}
    >
      {children}
    </button>
  );
}

// ---------------- 工具函数 ----------------

// 把 ISO 时间格式化为"刚刚 / N 分钟前 / N 小时前 / N 天前 / 月日"，给卡片用
function formatLastOpened(lastOpenedAt: string | null, createdAt: string): string {
  const iso = lastOpenedAt ?? createdAt;
  const prefix = lastOpenedAt ? '上次打开 ' : '创建于 ';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return prefix + iso;
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return prefix + '刚刚';
  if (diffMin < 60) return `${prefix}${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${prefix}${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${prefix}${diffDay} 天前`;
  const d = new Date(ts);
  return `${prefix}${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

const primaryBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  background: color.ink900,
  color: '#FFFFFF',
  border: 'none',
  padding: '10px 20px',
  borderRadius: radius.pill,
  cursor: 'pointer',
  fontSize: text.sm,
  fontWeight: 600,
  boxShadow: shadow.lg,
  fontFamily: 'inherit',
};

const secondaryBtn: CSSProperties = {
  background: color.raised,
  color: color.ink700,
  border: `0.5px solid ${color.ink300}`,
  padding: '8px 16px',
  borderRadius: radius.md,
  cursor: 'pointer',
  fontSize: text.sm,
  fontWeight: 500,
  fontFamily: 'inherit',
};

const dangerBtn: CSSProperties = {
  background: color.danger,
  color: '#FFFFFF',
  border: 'none',
  padding: '8px 16px',
  borderRadius: radius.md,
  cursor: 'pointer',
  fontSize: text.sm,
  fontWeight: 600,
  fontFamily: 'inherit',
};
