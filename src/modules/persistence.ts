// persistence-module
// 提供基于 JSON 文件的本地存储。单用户、本地数据量小，文件读写够用。
// Stage 7+ 可平移到 SQLite（变更只在本文件，对外接口不变）。

import { promises as fs } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

interface Database {
  projects: Record<string, any>;
  canvases: Record<string, any>;
  nodes: Record<string, any>;
  edges: Record<string, any>;
  messages: Record<string, any>;
  settings: any | null;
}

const DEFAULT_DB: Database = {
  projects: {},
  canvases: {},
  nodes: {},
  edges: {},
  messages: {},
  settings: null,
};

export interface PersistenceAdapter {
  get<T>(table: keyof Database, id: string): Promise<T | null>;
  list<T>(table: keyof Database, filter?: (item: T) => boolean): Promise<T[]>;
  put<T>(table: keyof Database, id: string, value: T): Promise<void>;
  delete(table: keyof Database, id: string): Promise<void>;
  // 简化的事务：单进程下用串行写保证原子（删除级联用得到）
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  getSingleton<T>(): Promise<T | null>; // for settings
  putSingleton<T>(value: T): Promise<void>;
  // 测试辅助
  reset(): Promise<void>;
}

class FileAdapter implements PersistenceAdapter {
  private db: Database = structuredClone(DEFAULT_DB);
  private writeQueue: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private path: string) {}

  private async load() {
    if (this.loaded) return;
    try {
      const text = await fs.readFile(this.path, 'utf-8');
      this.db = JSON.parse(text);
      // 兼容旧版本：补齐字段
      this.db = { ...DEFAULT_DB, ...this.db };
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      // 首次启动：写入空 DB
      await fs.mkdir(dirname(this.path), { recursive: true });
      await fs.writeFile(this.path, JSON.stringify(this.db, null, 2));
    }
    this.loaded = true;
  }

  private async flush() {
    // 串行队列，保证写入原子
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.writeFile(this.path, JSON.stringify(this.db, null, 2));
    });
    return this.writeQueue;
  }

  async get<T>(table: keyof Database, id: string): Promise<T | null> {
    await this.load();
    const t = this.db[table];
    if (table === 'settings') return null;
    return ((t as Record<string, any>)[id] as T) ?? null;
  }

  async list<T>(table: keyof Database, filter?: (item: T) => boolean): Promise<T[]> {
    await this.load();
    if (table === 'settings') return [];
    const arr = Object.values(this.db[table] as Record<string, any>) as T[];
    return filter ? arr.filter(filter) : arr;
  }

  async put<T>(table: keyof Database, id: string, value: T): Promise<void> {
    await this.load();
    if (table === 'settings') {
      this.db.settings = value;
    } else {
      (this.db[table] as Record<string, any>)[id] = value;
    }
    await this.flush();
  }

  async delete(table: keyof Database, id: string): Promise<void> {
    await this.load();
    if (table === 'settings') {
      this.db.settings = null;
    } else {
      delete (this.db[table] as Record<string, any>)[id];
    }
    await this.flush();
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // 文件适配器：串行执行（单进程足够；多进程需要文件锁，MVP 不需要）
    await this.load();
    const result = await fn();
    await this.flush();
    return result;
  }

  async getSingleton<T>(): Promise<T | null> {
    await this.load();
    return this.db.settings as T | null;
  }

  async putSingleton<T>(value: T): Promise<void> {
    await this.load();
    this.db.settings = value;
    await this.flush();
  }

  async reset(): Promise<void> {
    this.db = structuredClone(DEFAULT_DB);
    await this.flush();
  }
}

let adapter: PersistenceAdapter | null = null;

export function getPersistence(): PersistenceAdapter {
  if (adapter) return adapter;
  // POWER_CHAT_DB 测试时指向临时文件，开发时默认在仓库根目录的 .data/db.json
  // CJS/ESM 双兼容：esbuild bundle 到 CJS 时 __dirname 已注入；ESM 运行时用 import.meta.url
  const dirPath = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  const dbPath = process.env.POWER_CHAT_DB ?? resolve(dirPath, '../../.data/db.json');
  adapter = new FileAdapter(dbPath);
  return adapter;
}

// 测试辅助：替换适配器（如内存模式）
export function setPersistence(a: PersistenceAdapter): void {
  adapter = a;
}
