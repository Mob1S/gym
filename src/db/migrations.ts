import type { SqlExecutor } from './types';
import { CREATE_META_SQL, CREATE_TABLES_SQL } from './schema';

export interface Migration {
  version: number;
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
 * 已经是最新版本时不做任何事。
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
