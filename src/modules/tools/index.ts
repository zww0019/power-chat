// 工具注册表 + OpenAI Function Calling 协议适配。
//
// agent.ts 调用方两种用法：
// - native_tools 模式：getToolsAsOpenAIFormat() 直接拼进 chat/completions 请求的 tools 字段
// - react_text 模式：getToolsAsTextDescriptor() 拼进 system prompt（M2 实现）
//
// 新工具按以下流程接入：
// 1. 在 src/types.ts 的 ToolName 中加新名字 + 对应 Args/Result 接口
// 2. 在 tools/ 下新建实现文件，导出 ToolDefinition
// 3. 在本文件 ALL_TOOLS 注册

import type { ToolDefinition } from './types.js';
import type { ToolName } from '../../types.js';
import { webSearchTool } from './web-search.js';
import { fetchPageTool } from './fetch-page.js';

export const ALL_TOOLS: Record<ToolName, ToolDefinition> = {
  web_search: webSearchTool as ToolDefinition,
  fetch_page: fetchPageTool as ToolDefinition,
};

export function getToolByName(name: ToolName): ToolDefinition {
  const tool = ALL_TOOLS[name];
  if (!tool) throw new Error(`unknown_tool: ${name}`);
  return tool;
}

// OpenAI Function Calling 兼容格式（native_tools 模式拼请求用）
export interface OpenAIToolDescriptor {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition['parameters'];
  };
}

// 静态注册表内容在运行期不变，预先生成 OpenAI 格式避免每次调用重建数组
const CACHED_OPENAI_TOOLS: OpenAIToolDescriptor[] = Object.values(ALL_TOOLS).map((t) => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

export function getToolsAsOpenAIFormat(): OpenAIToolDescriptor[] {
  return CACHED_OPENAI_TOOLS;
}

export type { ToolDefinition, ToolExecutionResult } from './types.js';
