import type { SQLiteDatabase } from 'expo-sqlite';
import type { SqlExecutor } from './types';

/**
 * 把 expo-sqlite 的数据库句柄适配成 `SqlExecutor`。
 *
 * 这一层是**薄适配器**：不做业务判断、不拼业务 SQL，只负责让上层代码不依赖
 * expo-sqlite。真正的原因是可测性 —— 仓储与迁移只认 `SqlExecutor` 接口，
 * 同一套逻辑才能换 `node:sqlite` 在 Jest 里跑。
 *
 * @param db `SQLite.openDatabaseAsync()` 返回的句柄
 * @returns 生产环境用的执行器
 */
export function createExpoExecutor(db: SQLiteDatabase): SqlExecutor {
  return {
    /**
     * 执行 SQL。**有没有参数会走两条不同的底层 API**，原因见函数内注释。
     *
     * @param sql 要执行的 SQL
     * @param params 占位符参数，默认空数组 —— 也就是默认走「多语句」那条分支
     */
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
    /**
     * 查询多行。
     *
     * @param sql 要执行的 SELECT
     * @param params 占位符参数
     * @returns 全部结果行；没有命中时是空数组，不做 null 转换（与接口约定一致）
     */
    async all<T>(sql: string, params: unknown[] = []) {
      return db.getAllAsync<T>(sql, params as never[]);
    },
    /**
     * 查询单行。
     *
     * 底层的 `getFirstAsync` 在无结果时可能给 `null` 也可能给 `undefined`，
     * 这里统一收敛成 `null` —— 调用方只需要判一种空值。
     *
     * @param sql 要执行的 SELECT
     * @param params 占位符参数
     * @returns 第一行；无结果时 null
     */
    async first<T>(sql: string, params: unknown[] = []) {
      const row = await db.getFirstAsync<T>(sql, params as never[]);
      return row ?? null;
    },
  };
}
