import type { SqlExecutor } from '../db/types';
import type { SessionExercise, WorkoutSession } from '../domain/types';
import { newId } from '../lib/id';

interface SessionRow {
  id: string;
  name: string | null;
  started_at: number;
  finished_at: number | null;
  note: string | null;
}

interface SessionExerciseRow {
  id: string;
  session_id: string;
  exercise_id: string;
  position: number;
  note: string | null;
}

function toSession(row: SessionRow): WorkoutSession {
  return {
    id: row.id,
    name: row.name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    note: row.note,
  };
}

function toSessionExercise(row: SessionExerciseRow): SessionExercise {
  return {
    id: row.id,
    sessionId: row.session_id,
    exerciseId: row.exercise_id,
    position: row.position,
    note: row.note,
  };
}

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
    'SELECT id, name, started_at, finished_at, note FROM session WHERE id = ?',
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
    `SELECT id, name, started_at, finished_at, note FROM session
     WHERE finished_at IS NULL
     ORDER BY started_at DESC
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
    `SELECT id, name, started_at, finished_at, note FROM session
     WHERE finished_at IS NOT NULL
     ORDER BY started_at DESC
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
    `SELECT id, session_id, exercise_id, position, note FROM session_exercise
     WHERE session_id = ?
     ORDER BY position ASC`,
    [sessionId],
  );
  return rows.map(toSessionExercise);
}
