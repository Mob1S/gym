import type { SQLiteDatabase } from 'expo-sqlite';
import type { SqlExecutor } from './types';

export function createExpoExecutor(db: SQLiteDatabase): SqlExecutor {
  return {
    async run(sql, params = []) {
      // 与 node 适配器（__tests__/nodeExecutor.ts）保持一致：无参数时走 execAsync。
      // runAsync 底层是 prepareAsync，只会执行字符串里的第一条语句，
      // 而迁移的建表脚本是多语句的 —— 用 runAsync 会静默漏建后面的表。
      if (params.length === 0) {
        await db.execAsync(sql);
        return;
      }
      await db.runAsync(sql, params as never[]);
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.getAllAsync<T>(sql, params as never[]);
    },
    async first<T>(sql: string, params: unknown[] = []) {
      const row = await db.getFirstAsync<T>(sql, params as never[]);
      return row ?? null;
    },
  };
}
