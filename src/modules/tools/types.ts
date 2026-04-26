// 工具协议定义。所有工具必须实现 ToolDefinition；agent loop 通过统一接口调用。
//
// parameters 字段直接采用 OpenAI Function Calling 兼容的 JSON Schema，
// 这样 native_tools 模式可零拷贝拼装 request；react_text 模式由 agent.ts
// 把 description + parameters 反向序列化进 system prompt。

import type { ToolName } from '../../types.js';

export interface ToolJsonSchema {
  type: 'object';
  properties: Record<string, ToolJsonSchemaProperty>;
  required?: string[];
}

export interface ToolJsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  default?: unknown;
  enum?: readonly string[];
  items?: ToolJsonSchemaProperty;
}

export interface ToolExecutionResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ToolDefinition<TArgs = unknown, TData = unknown> {
  name: ToolName;
  description: string;
  parameters: ToolJsonSchema;
  // signal 由 agent.ts 注入；用户中断 / 超时硬约束 / 用户输入新消息均通过 abort 传播
  execute(args: TArgs, signal?: AbortSignal): Promise<ToolExecutionResult<TData>>;
}
