import { describe, it, expect } from 'vitest';
import { mergeReasoningDeltas } from '../../../src/modules/_utils';
import type { ReasoningDetail } from '../../../src/types';

// 修复 OpenRouter→Bedrock→Anthropic Claude 路径下"Invalid signature in thinking block"：
// 单个 thinking block 跨多帧 SSE 推送时，必须按 index 合并增量，不能 spread 追加

describe('mergeReasoningDeltas · 按 index 合并多帧增量', () => {
  it('同 index 多帧：text 累加，signature 在最后一帧补齐', () => {
    const buf: ReasoningDetail[] = [];
    // 帧1：元数据
    let cur = mergeReasoningDeltas(buf, [
      { type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', id: 'rd_1' },
    ]);
    // 帧2：文本增量
    cur = mergeReasoningDeltas(cur, [{ type: 'reasoning.text', index: 0, text: '让我' }]);
    cur = mergeReasoningDeltas(cur, [{ type: 'reasoning.text', index: 0, text: '想想…' }]);
    // 帧3：签名
    cur = mergeReasoningDeltas(cur, [
      { type: 'reasoning.text', index: 0, signature: 'EqABCDE_signature_xyz' },
    ]);

    expect(cur).toHaveLength(1);
    expect(cur[0]).toMatchObject({
      type: 'reasoning.text',
      index: 0,
      format: 'anthropic-claude-v1',
      id: 'rd_1',
      text: '让我想想…',
      signature: 'EqABCDE_signature_xyz',
    });
  });

  it('不同 index 各自独立累积，互不干扰', () => {
    const buf: ReasoningDetail[] = [];
    let cur = mergeReasoningDeltas(buf, [
      { type: 'reasoning.text', index: 0, text: 'A1' },
      { type: 'reasoning.text', index: 1, text: 'B1' },
    ]);
    cur = mergeReasoningDeltas(cur, [
      { type: 'reasoning.text', index: 0, text: 'A2', signature: 'sig0' },
    ]);
    cur = mergeReasoningDeltas(cur, [
      { type: 'reasoning.text', index: 1, text: 'B2', signature: 'sig1' },
    ]);

    expect(cur).toHaveLength(2);
    expect(cur[0]).toMatchObject({ index: 0, text: 'A1A2', signature: 'sig0' });
    expect(cur[1]).toMatchObject({ index: 1, text: 'B1B2', signature: 'sig1' });
  });

  it('data 与 summary 字段同样按累加合并（非 text 文本字段）', () => {
    const cur = mergeReasoningDeltas(
      [{ type: 'reasoning.encrypted', index: 0, data: 'enc_part1' }],
      [{ type: 'reasoning.encrypted', index: 0, data: 'enc_part2', signature: 'sig' }],
    );
    expect(cur[0]).toMatchObject({ data: 'enc_part1enc_part2', signature: 'sig' });
  });

  it('无 index 的元素不与已有元素合并，作为新元素追加（向后兼容 mock）', () => {
    const cur = mergeReasoningDeltas(
      [{ type: 'reasoning.text', text: 'first', format: 'anthropic-claude-v1' }],
      [{ type: 'reasoning.text', text: 'second', format: 'anthropic-claude-v1' }],
    );
    expect(cur).toHaveLength(2);
    expect(cur[0]!.text).toBe('first');
    expect(cur[1]!.text).toBe('second');
  });

  it('空 delta 不修改 buffer 内容', () => {
    const buf: ReasoningDetail[] = [{ type: 'reasoning.text', index: 0, text: 'x' }];
    const cur = mergeReasoningDeltas(buf, []);
    expect(cur).toHaveLength(1);
    expect(cur[0]!.text).toBe('x');
  });

  it('返回新数组引用，不修改原 buf（保持 buffer 不可变假设）', () => {
    const buf: ReasoningDetail[] = [{ type: 'reasoning.text', index: 0, text: 'orig' }];
    const cur = mergeReasoningDeltas(buf, [{ type: 'reasoning.text', index: 0, text: '+more' }]);
    expect(cur).not.toBe(buf);
    expect(buf[0]!.text).toBe('orig'); // 原 buf 元素不被改写
    expect(cur[0]!.text).toBe('orig+more');
  });

  it('后到帧的 type/format/id 覆盖前到（取最新非 undefined 值）', () => {
    const cur = mergeReasoningDeltas(
      [{ type: 'reasoning.text', index: 0, format: 'old-format' }],
      [{ type: 'reasoning.summary', index: 0, format: 'anthropic-claude-v1', id: 'rd_late' }],
    );
    expect(cur[0]).toMatchObject({
      type: 'reasoning.summary',
      format: 'anthropic-claude-v1',
      id: 'rd_late',
    });
  });

  it('null 不覆盖已有合法值（防止占位 null 反向清空 signature）', () => {
    const cur = mergeReasoningDeltas(
      [{ type: 'reasoning.text', index: 0, text: 't', signature: 'real_sig' }],
      // 后到帧把 signature 显式设为 null（OpenRouter ReasoningDetail.signature 类型允许 null）
      [{ type: 'reasoning.text', index: 0, signature: null }],
    );
    // 已有的 real_sig 不应被 null 覆盖
    expect(cur[0]!.signature).toBe('real_sig');
  });

  it('真实场景：模拟 Anthropic Claude 思考块 3 帧推送序列', () => {
    // 还原 OpenRouter→Bedrock 实际流式协议：start / delta×N / signature
    let buf: ReasoningDetail[] = [];
    // content_block_start：仅元数据，无 text，无 signature
    buf = mergeReasoningDeltas(buf, [
      { type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', id: 'rd_abc' },
    ]);
    // 多个 thinking_delta
    for (const piece of ['I need to ', 'analyze this ', 'carefully…']) {
      buf = mergeReasoningDeltas(buf, [{ type: 'reasoning.text', index: 0, text: piece }]);
    }
    // signature_delta（最后一帧）
    buf = mergeReasoningDeltas(buf, [
      { type: 'reasoning.text', index: 0, signature: 'EqABCDE...' },
    ]);

    // 关键断言：合并后只有 1 个完整 block，含完整 text 和 signature
    expect(buf).toHaveLength(1);
    expect(buf[0]!.text).toBe('I need to analyze this carefully…');
    expect(buf[0]!.signature).toBe('EqABCDE...');
    expect(buf[0]!.id).toBe('rd_abc');
    expect(buf[0]!.format).toBe('anthropic-claude-v1');
  });
});
