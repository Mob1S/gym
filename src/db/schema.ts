/**
 * 建表 SQL。测试（node:sqlite）与生产（expo-sqlite）共用同一份字符串，
 * 因此这里任何语法错误都会在单元测试里立刻暴露。
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

export const CREATE_META_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
