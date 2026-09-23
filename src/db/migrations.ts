import type { SqlExecutor } from './types';
import { CREATE_META_SQL, CREATE_TABLES_SQL } from './schema';

/**
 * 一个版本化迁移项。
 *
 * `version` 从 1 开始连续编号，`migrate()` 按它升序执行所有大于当前版本的项。
 * 一个版本里可以有多条语句，它们会**逐条执行**，但**不在同一个事务里** ——
 * 所以单条语句必须是幂等的（都写成 `CREATE ... IF NOT EXISTS`）。
 */
export interface Migration {
  /** 目标版本号；库里的 `schema_version` 小于它时这一项才会被执行 */
  version: number;
  /** 该版本要执行的语句，按数组顺序执行 */
  statements: string[];
}

/**
 * 版本化迁移。新增 schema 变更时追加一项，不要修改已发布的项。
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [CREATE_META_SQL, CREATE_TABLES_SQL],
  },
];

/**
 * 读出当前库结构版本。
 *
 * @param exec SQL 执行器
 * @returns 已应用的版本号；**全新数据库（`app_meta` 都还不存在）时返回 0**，
 *          于是所有迁移都会被判定为「待执行」
 */
export async function getSchemaVersion(exec: SqlExecutor): Promise<number> {
  // 全新数据库里 app_meta 还不存在，直接查会抛 "no such table"。
  // 迁移尚未跑过时版本号定义为 0。
  const meta = await exec.first<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'",
  );
  if (!meta) return 0;

  const row = await exec.first<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = 'schema_version'",
  );
  return row ? Number(row.value) : 0;
}

/**
 * 依次执行尚未应用的迁移，完成后写入新的版本号。
 * 已经是最新版本时不做任何事（幂等，每次启动都会调用）。
 *
 * @param exec SQL 执行器
 * @returns 迁移全部跑完后 resolve；无返回值
 */
export async function migrate(exec: SqlExecutor): Promise<void> {
  // app_meta 必须先存在，否则读不到版本号
  await exec.run(CREATE_META_SQL);

  const current = await getSchemaVersion(exec);
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    for (const statement of migration.statements) {
      await exec.run(statement);
    }
    await exec.run(
      `INSERT INTO app_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(migration.version)],
    );
  }
}
