// 通用 SSE 字节流解析。零依赖，前后端、测试三方共享。
//
// 使用：
// ```
// for await (const line of readSSELines(response.body)) {
//   const obj = parseSSEData<MyEvent>(line);
//   if (obj) handle(obj);
// }
// ```
/**
 * 把 ReadableStream 按行（`\n` 分隔）拆出字符串，跨 chunk 维护未完成行的 buffer。
 *
 * 不用 TransformStream / TextDecoderStream 是因为测试环境（Node 18 vitest）对
 * ReadableStream pipeline API 的支持不完整，手动 buffer 拼接可在所有宿主环境一致运行。
 */
export async function* readSSELines(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines)
            yield line;
    }
}
/**
 * 解析单条 SSE `data: {json}` 帧。
 * 非 data 行 / `[DONE]` 标记 / 解析失败 → 返回 null。
 */
export function parseSSEData(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: '))
        return null;
    const body = trimmed.slice(6).trim();
    if (!body || body === '[DONE]')
        return null;
    try {
        return JSON.parse(body);
    }
    catch {
        return null;
    }
}
