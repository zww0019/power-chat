import { describe, it, expect } from 'vitest';
import { parseSSELine } from '../../../src/modules/llm-client';
import type { StreamEvent } from '../../../src/types';

// SSE 解析层：根因 B 修复——OpenRouter / Anthropic / DeepSeek 三家协议字段名取并集

function makeFrame(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [{ delta }] })}`;
}

describe('parseSSELine · reasoning 字段并集解析', () => {
  it('delta.reasoning_content（DeepSeek 私有字段）→ reasoning 事件', () => {
    const result = parseSSELine(makeFrame({ reasoning_content: '思考第一步' }), 'm0');
    expect(result.events).toContainEqual({ type: 'reasoning', delta: '思考第一步' });
  });

  it('delta.reasoning（OpenRouter / Anthropic 标准化字段）→ reasoning 事件', () => {
    const result = parseSSELine(makeFrame({ reasoning: '让我想想...' }), 'm0');
    expect(result.events).toContainEqual({ type: 'reasoning', delta: '让我想想...' });
  });

  it('delta.reasoning_details 数组同时 yield reasoning（拍平文本） + reasoning_details 事件', () => {
    const detail = { type: 'reasoning.text', text: 'detailed thought', format: 'anthropic-claude-v1', index: 0 };
    const result = parseSSELine(makeFrame({ reasoning_details: [detail] }), 'm0');
    expect(result.events).toContainEqual({ type: 'reasoning', delta: 'detailed thought' });
    expect(result.events).toContainEqual({ type: 'reasoning_details', delta: [detail] });
  });

  it('reasoning 比 reasoning_content 优先级更高', () => {
    const result = parseSSELine(
      makeFrame({ reasoning: 'A', reasoning_content: 'B' }),
      'm0',
    );
    const r = result.events.find((e: StreamEvent) => e.type === 'reasoning')!;
    expect((r as { delta: string }).delta).toBe('A');
  });

  it('content 字段独立 yield，不被 reasoning 抢占', () => {
    const result = parseSSELine(
      makeFrame({ reasoning: '思考', content: '回答' }),
      'm0',
    );
    expect(result.events).toContainEqual({ type: 'reasoning', delta: '思考' });
    expect(result.events).toContainEqual({ type: 'content', delta: '回答' });
  });

  it('summary 类型的 reasoning_detail 也能被拍平到文本', () => {
    const detail = { type: 'reasoning.summary', summary: '总结性思考', format: 'anthropic-claude-v1', index: 0 };
    const result = parseSSELine(makeFrame({ reasoning_details: [detail] }), 'm0');
    const r = result.events.find((e: StreamEvent) => e.type === 'reasoning')!;
    expect((r as { delta: string }).delta).toBe('总结性思考');
  });

  it('空 reasoning_details 数组不 yield reasoning_details 事件', () => {
    const result = parseSSELine(makeFrame({ reasoning_details: [] }), 'm0');
    const detailsEvt = result.events.find((e: StreamEvent) => e.type === 'reasoning_details');
    expect(detailsEvt).toBeUndefined();
  });

  it('[DONE] 帧不产出事件', () => {
    const result = parseSSELine('data: [DONE]', 'm0');
    expect(result.events).toEqual([]);
  });
});
