/**
 * 建表 SQL。测试（node:sqlite）与生产（expo-sqlite）共用同一份字符串，
 * 因此这里任何语法错误都会在单元测试里立刻暴露。
 *
 * 四张表与 `domain/types.ts` 的实体一一对应：
 * - `exercise` 动作库，预置动作与用户自建动作都在这里（`is_custom` 区分）
 * - `session` 一次训练，`finished_at` 为 NULL 就是「进行中」
 * - `session_exercise` 训练里的动作及顺序，`position` 决定界面上的先后
 * - `set_entry` 每一组：重量、次数、完成状态、休息时长
 *
 * 三点全局约定：
 * - 三个外键都写 `ON DELETE CASCADE`，但**级联要生效必须先开
 *   `PRAGMA foreign_keys = ON`**，而那个开关是连接级的（在
 *   `repositories/database.tsx` 建库后立刻打开，测试适配器同样打开）。
 * - 时间一律存**毫秒时间戳**（INTEGER），不存字符串日期。
 * - 布尔一律存 0/1：SQLite 没有布尔类型，`SqlExecutor` 里也不会有。
 *
 * 末三行是索引。它们不是可选的：历史列表按 `finished_at` 筛、进步页要按
 * `session_exercise_id` 反查组，没有索引会退化成全表扫描。
 */
export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS exercise (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  muscle_group  TEXT,
  equipment     TEXT,
  is_custom     INTEGER NOT NULL DEFAULT 0,
  is_archived   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS session_exercise (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercise(id),
  position    INTEGER NOT NULL,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS set_entry (
  id                  TEXT PRIMARY KEY,
  session_exercise_id TEXT NOT NULL REFERENCES session_exercise(id) ON DELETE CASCADE,
  position            INTEGER NOT NULL,
  weight              REAL NOT NULL,
  reps                INTEGER NOT NULL,
  is_completed        INTEGER NOT NULL DEFAULT 0,
  rest_seconds        INTEGER,
  rest_started_at     INTEGER,
  completed_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_session_finished ON session(finished_at);
CREATE INDEX IF NOT EXISTS idx_session_exercise_session ON session_exercise(session_id);
CREATE INDEX IF NOT EXISTS idx_set_entry_session_exercise ON set_entry(session_exercise_id);
`;

/**
 * 迁移版本号表。键值对形式，目前只存 `schema_version` 一个键。
 *
 * 单独建这一张表，是因为它必须是**全新数据库里第一张被建出来的表**：
 * `migrate()` 要先把版本号读出来，才知道该跑哪些迁移，所以它不能属于任何一个
 * 版本化迁移项（那样就成了先有鸡还是先有蛋）。
 */
export const CREATE_META_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
