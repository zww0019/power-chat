import { describe, it, expect } from 'vitest';
import { buildOpenAIRequestBody } from '../../../src/modules/llm-client';
import type { LLMMessage, ReasoningDetail } from '../../../src/types';

// 不依赖 mock-server，直接断言 buildOpenAIRequestBody 在四个 provider 下的请求体形态。
// 这是 OpenRouter reasoning 改造的核心契约——字段名错就一切失效（根因 A）

const baseMessages: LLMMessage[] = [
  { role: 'user', content: '中国新茶饮品牌出海有哪些主要阻力？' },
];

describe('buildOpenAIRequestBody · provider 分支', () => {
  it('openrouter + enableReasoning=true 输出 reasoning.effort 字段', () => {
    const body = buildOpenAIRequestBody(
      { messages: baseMessages, enableReasoning: true },
      'anthropic/claude-sonnet-4.5',
      'openrouter',
      'medium',
    );
    expect(body.reasoning).toEqual({ effort: 'medium', exclude: false });
  });

  it('openrouter 接受 high effort 并透传', () => {
    const body = buildOpenAIRequestBody(
      { messages: baseMessages, enableReasoning: true },
      'anthropic/claude-sonnet-4.5',
      'openrouter',
      'high',
    );
    expect((body.reasoning as { effort: string }).effort).toBe('high');
  });

  it('openai 走 reasoning.effort 路径', () => {
    const body = buildOpenAIRequestBody(
      { messages: baseMessages, enableReasoning: true },
      'o3-mini',
      'openai',
      'low',
    );
    expect(body.reasoning).toEqual({ effort: 'low', exclude: false });
  });

  it('deepseek 不写 reasoning 字段（DeepSeek-R1 通过模型名自动启用）', () => {
    const body = buildOpenAIRequestBody(
      { messages: baseMessages, enableReasoning: true },
      'deepseek-reasoner',
      'deepseek',
      'medium',
    );
    expect(body).not.toHaveProperty('reasoning');
  });

  it('custom 兜底保留旧契约 { enabled: true } 不破坏既有自建端点', () => {
    const body = buildOpenAIRequestBody(
      { messages: baseMessages, enableReasoning: true },
      'gpt-4o',
      'custom',
      'medium',
    );
    expect(body.reasoning).toEqual({ enabled: true });
  });

  it('enableReasoning=false 时所有 provider 都不输出 reasoning 字段', () => {
    for (const provider of ['openrouter', 'openai', 'deepseek', 'custom'] as const) {
      const body = buildOpenAIRequestBody(
        { messages: baseMessages, enableReasoning: false },
        'm',
        provider,
        'medium',
      );
      expect(body).not.toHaveProperty('reasoning');
    }
  });
});

describe('buildOpenAIRequestBody · reasoning_details 回填', () => {
  const details: ReasoningDetail[] = [
    { type: 'reasoning.text', text: '我先...', format: 'anthropic-claude-v1', id: 'rd1', index: 0 },
  ];
  const messagesWithDetails: LLMMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a', reasoningDetails: details },
  ];

  it('openrouter 把 assistant 历史的 reasoning_details 回灌到请求体', () => {
    const body = buildOpenAIRequestBody(
      { messages: messagesWithDetails, enableReasoning: true },
      'anthropic/claude-sonnet-4.5',
      'openrouter',
      'medium',
    );
    const msgs = body.messages as Array<Record<string, unknown>>;
    const assistant = msgs.find((m) => m.role === 'assistant')!;
    expect(assistant.reasoning_details).toEqual(details);
  });

  it('其他 provider 不回灌 reasoning_details（避免中转端点 400）', () => {
    for (const provider of ['openai', 'deepseek', 'custom'] as const) {
      const body = buildOpenAIRequestBody(
        { messages: messagesWithDetails, enableReasoning: true },
        'm',
        provider,
        'medium',
      );
      const msgs = body.messages as Array<Record<string, unknown>>;
      const assistant = msgs.find((m) => m.role === 'assistant')!;
      expect(assistant).not.toHaveProperty('reasoning_details');
    }
  });
});
