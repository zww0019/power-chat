// persistence-module
// 提供基于 JSON 文件的本地存储。MVP 单用户单画布，数据量小，文件读写够用。
// Stage 7+ 可平移到 SQLite（变更只在本文件，对外接口不变）。
import { promises as fs } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
const DEFAULT_DB = {
    canvases: {},
    nodes: {},
    edges: {},
    messages: {},
    settings: null,
};
class FileAdapter {
    path;
    db = structuredClone(DEFAULT_DB);
    writeQueue = Promise.resolve();
    loaded = false;
    constructor(path) {
        this.path = path;
    }
    async load() {
        if (this.loaded)
            return;
        try {
            const text = await fs.readFile(this.path, 'utf-8');
            this.db = JSON.parse(text);
            // 兼容旧版本：补齐字段
            this.db = { ...DEFAULT_DB, ...this.db };
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
            // 首次启动：写入空 DB
            await fs.mkdir(dirname(this.path), { recursive: true });
            await fs.writeFile(this.path, JSON.stringify(this.db, null, 2));
        }
        this.loaded = true;
    }
    async flush() {
        // 串行队列，保证写入原子
        this.writeQueue = this.writeQueue.then(async () => {
            await fs.writeFile(this.path, JSON.stringify(this.db, null, 2));
        });
        return this.writeQueue;
    }
    async get(table, id) {
        await this.load();
        const t = this.db[table];
        if (table === 'settings')
            return null;
        return t[id] ?? null;
    }
    async list(table, filter) {
        await this.load();
        if (table === 'settings')
            return [];
        const arr = Object.values(this.db[table]);
        return filter ? arr.filter(filter) : arr;
    }
    async put(table, id, value) {
        await this.load();
        if (table === 'settings') {
            this.db.settings = value;
        }
        else {
            this.db[table][id] = value;
        }
        await this.flush();
    }
    async delete(table, id) {
        await this.load();
        if (table === 'settings') {
            this.db.settings = null;
        }
        else {
            delete this.db[table][id];
        }
        await this.flush();
    }
    async transaction(fn) {
        // 文件适配器：串行执行（单进程足够；多进程需要文件锁，MVP 不需要）
        await this.load();
        const result = await fn();
        await this.flush();
        return result;
    }
    async getSingleton() {
        await this.load();
        return this.db.settings;
    }
    async putSingleton(value) {
        await this.load();
        this.db.settings = value;
        await this.flush();
    }
    async reset() {
        this.db = structuredClone(DEFAULT_DB);
        await this.flush();
    }
}
let adapter = null;
export function getPersistence() {
    if (adapter)
        return adapter;
    // POWER_CHAT_DB 测试时指向临时文件，开发时默认在仓库根目录的 .data/db.json
    // CJS/ESM 双兼容：esbuild bundle 到 CJS 时 __dirname 已注入；ESM 运行时用 import.meta.url
    const __dir = typeof __dirname !== 'undefined'
        ? __dirname
        : dirname(fileURLToPath(import.meta.url));
    const dbPath = process.env.POWER_CHAT_DB
        ?? resolve(__dir, '../../.data/db.json');
    adapter = new FileAdapter(dbPath);
    return adapter;
}
// 测试辅助：替换适配器（如内存模式）
export function setPersistence(a) {
    adapter = a;
}
