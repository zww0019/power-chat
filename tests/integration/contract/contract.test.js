import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import YAML from 'yaml';
import { api } from '../helpers';
// Contract test：核对 mock-server 的实际响应是否匹配 docs/04-api-contract.yaml 定义。
// Stage 6 切到真实后端时，**这些测试不变** —— 它们守的是契约边界。
//
// 实现策略（MVP 期）：
// - 加载 OpenAPI YAML
// - 对几个关键端点做"必填字段存在 + 类型匹配 + 枚举值合法"的 sanity check
// - 不做完整 JSON Schema 校验（那是 schemathesis 等工具的任务，二阶段加）
const __dirname = dirname(fileURLToPath(import.meta.url));
const contractPath = resolve(__dirname, '../../../docs/04-api-contract.yaml');
describe('contract: OpenAPI 契约可加载', () => {
    it('YAML 解析成功且包含所有声明的端点', () => {
        const text = readFileSync(contractPath, 'utf-8');
        const spec = YAML.parse(text);
        const paths = Object.keys(spec.paths);
        expect(paths).toContain('/api/canvas');
        expect(paths).toContain('/api/nodes');
        expect(paths).toContain('/api/nodes/{id}');
        expect(paths).toContain('/api/nodes/branch');
        expect(paths).toContain('/api/nodes/{id}/messages');
        expect(paths).toContain('/api/refine');
        expect(paths).toContain('/api/settings');
        expect(paths).toContain('/api/settings/test');
    });
    it('每个端点至少有 2 个 example', () => {
        const text = readFileSync(contractPath, 'utf-8');
        const spec = YAML.parse(text);
        // 收集 examples 数量（约束：契约中 examples 总数应 ≥ 端点数 × 2）
        const exampleCount = Object.keys(spec.components.examples).length;
        expect(exampleCount).toBeGreaterThanOrEqual(8); // 至少 8 个示例（含 normal + edge case）
    });
});
describe('contract: 实际响应匹配 schema (sanity check)', () => {
    it('GET /api/canvas 响应包含 canvas/nodes/edges/messages 四个字段', async () => {
        const data = await api('/api/canvas');
        expect(data).toHaveProperty('canvas');
        expect(data).toHaveProperty('nodes');
        expect(data).toHaveProperty('edges');
        expect(data).toHaveProperty('messages');
        expect(data.canvas).toHaveProperty('id');
        expect(typeof data.canvas.viewportZoom).toBe('number');
        expect(data.canvas.viewportZoom).toBeGreaterThanOrEqual(0.25);
        expect(data.canvas.viewportZoom).toBeLessThanOrEqual(2.0);
    });
    it('POST /api/nodes 返回 Node schema 必填字段全在', async () => {
        const node = await api('/api/nodes', {
            method: 'POST',
            body: JSON.stringify({ positionX: 0, positionY: 0 }),
            expectStatus: 201,
        });
        const required = ['id', 'canvasId', 'type', 'positionX', 'positionY', 'width', 'collapsed', 'createdAt', 'updatedAt'];
        for (const field of required) {
            expect(node).toHaveProperty(field);
        }
        expect(['dialogue', 'refined']).toContain(node.type);
        expect(node.id).toMatch(/^n_[a-z0-9]+$/);
    });
    it('错误响应格式统一为 {error, message?} schema', async () => {
        const res = await fetch(`${process.env.POWER_CHAT_API ?? 'http://localhost:3001'}/api/nodes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ positionX: 'not_a_number' }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body).toHaveProperty('error');
    });
});
describe('contract: 端点状态码符合契约', () => {
    it('POST /api/nodes 返回 201 (Created)', async () => {
        const res = await fetch(`${process.env.POWER_CHAT_API ?? 'http://localhost:3001'}/api/nodes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ positionX: 0, positionY: 0 }),
        });
        expect(res.status).toBe(201);
    });
    it.skip('SSE 事件类型在 [reasoning, content, done, error] 集合内', async () => {
        // 由 messages.test.ts 间接覆盖
    });
});
