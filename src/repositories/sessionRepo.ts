import type { SqlExecutor } from '../db/types';
import type { SessionExercise, WorkoutSession } from '../domain/types';
import { newId } from '../lib/id';

/**
 * 行 → 实体的映射与列清单。**导出给 `backupRepo` 复用**：备份导出的行映射与仓储
 * 读数据的行映射必须是同一份，复制一份迟早会漂移，而漂移的表现是「导出的文件
 * 字段对不上」，极难排查。
 */
export interface SessionRow {
  id: string;
  name: string | null;
  started_at: number;
  finished_at: number | null;
  note: string | null;
}

export interface SessionExerciseRow {
  id: string;
  session_id: string;
  exercise_id: string;
  position: number;
  note: string | null;
}

export function toSession(row: SessionRow): WorkoutSession {
  return {
    id: row.id,
    name: row.name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    note: row.note,
  };
}

export function toSessionExercise(row: SessionExerciseRow): SessionExercise {
  return {
    id: row.id,
    sessionId: row.session_id,
    exerciseId: row.exercise_id,
    position: row.position,
    note: row.note,
  };
}

/** 本文件内的查询与 `backupRepo` 共用，保证 SELECT 的列与映射永远对得上 */
export const SESSION_COLUMNS = 'id, name, started_at, finished_at, note';

export const SESSION_EXERCISE_COLUMNS =
  'id, session_id, exercise_id, position, note';

export async function createSession(
  exec: SqlExecutor,
  name: string | null,
): Promise<WorkoutSession> {
  const session: WorkoutSession = {
    id: newId(),
    name,
    startedAt: Date.now(),
    finishedAt: null,
    note: null,
  };
  await exec.run(
    'INSERT INTO session (id, name, started_at, finished_at, note) VALUES (?, ?, ?, NULL, NULL)',
    [session.id, session.name, session.startedAt],
  );
  return session;
}

export async function getSession(
  exec: SqlExecutor,
  id: string,
): Promise<WorkoutSession | null> {
  const row = await exec.first<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM session WHERE id = ?`,
    [id],
  );
  return row ? toSession(row) : null;
}

/**
 * 取当前进行中的训练。
 *
 * 理论上同时只该有一条未结束的记录，但 App 被强杀可能留下残留，
 * 所以按开始时间倒序取最新的一条，而不是断言唯一。
 */
export async function getActiveSession(
  exec: SqlExecutor,
): Promise<WorkoutSession | null> {
  const row = await exec.first<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM session
     WHERE finished_at IS NULL
     ORDER BY started_at DESC, rowid DESC
     LIMIT 1`,
  );
  return row ? toSession(row) : null;
}

export async function finishSession(
  exec: SqlExecutor,
  id: string,
  finishedAt: number,
): Promise<void> {
  await exec.run('UPDATE session SET finished_at = ? WHERE id = ?', [
    finishedAt,
    id,
  ]);
}

export async function listSessions(
  exec: SqlExecutor,
  limit: number,
): Promise<WorkoutSession[]> {
  const rows = await exec.all<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM session
     WHERE finished_at IS NOT NULL
     ORDER BY started_at DESC, rowid DESC
     LIMIT ?`,
    [limit],
  );
  return rows.map(toSession);
}

export async function addExerciseToSession(
  exec: SqlExecutor,
  sessionId: string,
  exerciseId: string,
): Promise<SessionExercise> {
  const row = await exec.first<{ next: number | null }>(
    'SELECT MAX(position) + 1 AS next FROM session_exercise WHERE session_id = ?',
    [sessionId],
  );
  const position = row?.next ?? 0;

  const sessionExercise: SessionExercise = {
    id: newId(),
    sessionId,
    exerciseId,
    position,
    note: null,
  };

  await exec.run(
    `INSERT INTO session_exercise (id, session_id, exercise_id, position, note)
     VALUES (?, ?, ?, ?, NULL)`,
    [sessionExercise.id, sessionId, exerciseId, position],
  );

  return sessionExercise;
}

export async function listSessionExercises(
  exec: SqlExecutor,
  sessionId: string,
): Promise<SessionExercise[]> {
  const rows = await exec.all<SessionExerciseRow>(
    `SELECT ${SESSION_EXERCISE_COLUMNS} FROM session_exercise
     WHERE session_id = ?
     ORDER BY position ASC`,
    [sessionId],
  );
  return rows.map(toSessionExercise);
}

export interface SessionSummary {
  id: string;
  name: string | null;
  startedAt: number;
  /** 已结束的训练，finishedAt 一定非空 */
  finishedAt: number;
  durationMinutes: number;
  setCount: number;
  /** 容量负荷（volume load）= Σ(重量 × 次数)，只算已完成的组 */
  volumeKg: number;
}

interface SessionSummaryRow {
  id: string;
  name: string | null;
  started_at: number;
  finished_at: number;
  set_count: number;
  volume_kg: number;
}

/**
 * 一次查询取回历史列表所需的全部字段。
 *
 * 用聚合而不是「先查训练、再逐个查组」，是因为列表页要显示几十场训练 ——
 * N+1 查询在手机上会肉眼可见地卡。
 *
 * `ORDER BY started_at DESC, rowid DESC`：`started_at` 是毫秒时间戳，同毫秒
 * 建的两场训练会完全并列，此时 SQLite 按扫描顺序返回（即先建的在前），
 * 语义就反了。rowid 即插入顺序，用它兜底才有确定结果。
 */
export async function listSessionSummaries(
  exec: SqlExecutor,
  limit: number,
): Promise<SessionSummary[]> {
  const rows = await exec.all<SessionSummaryRow>(
    `SELECT
       s.id                AS id,
       s.name              AS name,
       s.started_at        AS started_at,
       s.finished_at       AS finished_at,
       COUNT(CASE WHEN st.is_completed = 1 THEN 1 END)                        AS set_count,
       COALESCE(SUM(CASE WHEN st.is_completed = 1 THEN st.weight * st.reps END), 0) AS volume_kg
     FROM session s
     LEFT JOIN session_exercise se ON se.session_id = s.id
     LEFT JOIN set_entry st        ON st.session_exercise_id = se.id
     WHERE s.finished_at IS NOT NULL
     GROUP BY s.id
     ORDER BY s.started_at DESC, s.rowid DESC
     LIMIT ?`,
    [limit],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMinutes: Math.max(
      0,
      Math.round((row.finished_at - row.started_at) / 60000),
    ),
    setCount: Number(row.set_count),
    volumeKg: Number(row.volume_kg),
  }));
}
