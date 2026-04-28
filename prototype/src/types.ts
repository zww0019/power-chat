// 共享类型从 src/types 导入，避免双份维护（D008 / R013 治理）。
// 仅 type-only re-export，不引入 src 中的 class（如 ContextOverflowError 等）。
//
// 不要在此文件重新定义 Message / Node / Edge 等核心类型——历史上两份定义
// 曾导致字段不同步（reasoningContent 可选性不一致），Stage 5 统一后形成此约定。

export type {
  NodeType,
  MessageRole,
  MessageStatus,
  EdgeKind,
  Canvas,
  Node,
  Edge,
  Message,
  Settings,
  SettingsProvider,
  ThinkingEffort,
  ReasoningDetail,
  StreamEvent,
  // Agent / Tool 类型（M1 起增量 re-export）
  AgentStep,
  AgentFinalReason,
  ToolName,
  ToolCallMode,
  LLMToolCall,
} from '../../src/types';

// === prototype 专属类型（src/types 中没有的部分）===

// 节点流式状态机（前端 store 派生状态，不持久化）
export type StreamingState = 'idle' | 'streaming' | 'error' | 'interrupted';

// HTTP / IPC 请求体的 prototype 端镜像（src 中各模块自己 inline 定义）
import type { NodeType } from '../../src/types';

export interface CreateNodeRequest {
  positionX: number;
  positionY: number;
  type?: NodeType;
}

export interface BranchRequest {
  parentNodeId: string;
  fromMessageId: string; // 从哪条 AI 消息分支
}

export interface RefineRequest {
  sourceNodeIds: string[];
  intentQuestion: string | null;
}

export interface SendMessageRequest {
  content: string;
}
