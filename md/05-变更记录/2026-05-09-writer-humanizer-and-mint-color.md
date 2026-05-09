# 撰写节点：去AI味单次化 + 薄荷绿配色 + 最终版替换写入

变更日期：2026-05-09

## 背景

撰写节点（type='written'）的 Phase 2 去AI味环节存在三个问题：
1. 三轮迭代——执行者改写后，批评者打分 < 8 分则把改写结果当新草稿再喂给执行者，AI 味在多轮间叠加而非消除
2. 撰写节点视觉上与对话节点完全同色（白底 paper），用户难以一眼识别
3. Phase 2 完成时后端把最终全文通过 `content` 事件推给前端，前端 `appendMessageContent` 走拼接语义，导致 message.content = "初稿全文 + 最终版全文" 双倍内容

## 变更内容

### 1. Phase 2 简化为单次执行

`src/modules/writer.ts`：
- 删除 `for round = 1..3` 循环、`humanizerCriticEvaluate` 函数、`HUMANIZER_CRITIC_PROMPT` 常量
- 改为单次调用 `humanizerExecRewrite(draftText)`，messages 数组永远是 `[system, user]` 两条干净消息，草稿不在多轮间循环
- 保留长度安全网：改写结果 < 初稿 50% 时回退初稿，防止 LLM 异常截断

### 2. SSE 契约：done 事件携带 finalContent

`src/types.ts`：
- StreamEvent 中 `done` 事件类型新增可选字段 `finalContent?: string`
- 删除 `rewrite_round` 事件类型（前端原本就未消费，简化契约）

`src/modules/writer.ts`：
- Phase 2 不再单独 `yield content`，而是在 `done` 事件附带 `finalContent`
- 仅当改写结果有效（非空、长度足够、与初稿不同）时设置 finalContent

### 3. 前端 replace 而非 append

`prototype/src/store/canvasStore.ts` 新增 `replaceMessageContent(msgId, content)` action（赋值替换语义）。

`prototype/src/canvas/nodeActions.ts` 的 `applyStreamEvent` done case：若 `evt.finalContent !== undefined`，先用乐观 ID 调 `replaceMessageContent`（此时 store 仍以 asstMsgId 为 key），再 `replaceMessageId` + `finalizeMessage`。对话/提炼节点 done 不带 finalContent，走原 finalize 路径不受影响。

### 4. 撰写节点配色：薄荷绿（mint/moss）

新增 token：
- `--surface-mint: #E5F1E2`、`--surface-mint-hi: #CFE5C7`（CSS + theme.ts 镜像）
- `--moss-200: #C2D6BD`（border 浅色）、`--moss-700: #2F4429`（深色文字）

`prototype/src/canvas/Node.tsx`：
- `buildNodeStyle` / `NodeHeader` / 顶部饰条 / `CollapsedCard` 分发处全部新增 `isWritten = node.type === 'written'` 分支
- 撰写节点图标使用 lucide `Feather`（vs 提炼=Sparkle / 对话=MessageSquare）
- 顶部 3px 薄荷渐变饰条 `linear-gradient(moss300, moss500)`，与提炼节点的焦糖渐变形成冷暖对照
- 新增 `CollapsedWrittenCard` 组件，仿 `CollapsedRefinedCard` 风格

## 节点配色规约（L2 约束）

| 节点类型 | 背景色 | border 默认 | header 文字 | 图标颜色 | 顶部饰条 | 图标 |
|---------|-------|------------|------------|---------|---------|------|
| 对话 dialogue | `paper` 白底 | `0.5px ink200` | `ink800` | `ink500` | 无 | MessageSquare |
| 提炼 refined | `warm` 焦糖 | `1px accent300` | `accent700` | `accent600` | accent400→500 渐变 | Sparkle |
| 撰写 written | `mint` 薄荷 | `1px moss300` | `moss700` | `moss600` | moss300→500 渐变 | Feather |

## 不做的事

- **旧数据迁移**：之前 append 模式产生的 written 节点 content 字段是"初稿+最终版拼接"。不做自动修复脚本（无法可靠还原拼接边界）；由用户手动删除并重新生成。
- **多模型分离**：去AI味仍走主 LLM（`provider`），未独立配置快模型。

## 关联代码

- 后端：`src/modules/writer.ts`、`src/types.ts`
- 前端：`prototype/src/canvas/Node.tsx`、`prototype/src/canvas/nodeActions.ts`、`prototype/src/store/canvasStore.ts`、`prototype/src/styles/tokens.css`、`prototype/src/styles/theme.ts`
- 测试：`tests/integration/writer/writer.test.ts`
