import { DatabaseSync } from 'node:sqlite';
import type { SqlExecutor } from '../types';

/**
 * 用 Node 24 内置的 node:sqlite 在内存里跑一份真实 SQLite。
 * 仅供测试使用——生产环境走 src/db/expoSqlite.ts。
 */
export function createNodeExecutor(): { exec: SqlExecutor; raw: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');

  const exec: SqlExecutor = {
    async run(sql, params = []) {
      // 无参数时必须走 exec：node:sqlite 的 prepare() 只会编译并执行字符串里的
      // 第一条语句，后面的静默丢弃（不报错），迁移用的建表脚本是多语句的。
      if (params.length === 0) {
        db.exec(sql);
        return;
      }
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async first<T>(sql: string, params: unknown[] = []) {
      const row = db.prepare(sql).get(...(params as never[]));
      return (row ?? null) as T | null;
    },
  };

  return { exec, raw: db };
}

/** 建好库并跑完迁移，返回可直接使用的执行器 */
export async function createMigratedExecutor(): Promise<SqlExecutor> {
  const { migrate } = await import('../migrations');
  const { exec } = createNodeExecutor();
  await migrate(exec);
  return exec;
}
