/**
 * 最小 SQL 执行接口。
 *
 * 数据库层只对外暴露这三个方法，是为了让上层（仓储、迁移、备份）**不依赖
 * expo-sqlite**：生产用 expo-sqlite 实现（`db/expoSqlite.ts`），测试用
 * `node:sqlite` 实现（`db/__tests__/nodeExecutor.ts`），同一套仓储代码两边都跑。
 * 任何仓储函数都只收这个接口，永远不收具体的数据库对象。
 */
export interface SqlExecutor {
  /**
   * 执行一条 SQL，不取返回行。
   *
   * 实现约定：**不传参数时要能跑多语句**（迁移的建表脚本是多条 CREATE 拼成的），
   * 传参数时按单条语句执行。这两个分支在两种实现里必须行为一致。
   *
   * @param sql 要执行的 SQL
   * @param params 占位符 `?` 对应的参数；省略或传空数组都表示「没有参数」
   * @returns 无返回行，只等它执行完
   */
  run(sql: string, params?: unknown[]): Promise<void>;
  /**
   * 查询多行。
   *
   * @param sql 要执行的 SELECT
   * @param params 占位符 `?` 对应的参数
   * @returns 全部结果行；**没有命中时是空数组，不是 null**，调用方不必判空
   */
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * 查询单行。
   *
   * `T` 是**数据库原始行**（snake_case 列名），不是 `domain/types.ts` 里的实体 ——
   * 列名到实体的转换由各仓储的 `toXxx()` 负责。
   *
   * @param sql 要执行的 SELECT，通常自带 LIMIT 1
   * @param params 占位符 `?` 对应的参数
   * @returns 第一行；**一行都没有时是 null**（不是 undefined），已统一抹平
   */
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
}

/**
 * 当前库结构版本，备份导出时写进文件的 `schemaVersion` 字段。
 * 必须与 `db/migrations.ts` 里 `MIGRATIONS` 的最后一项保持一致。
 */
export const SCHEMA_VERSION = 1;
