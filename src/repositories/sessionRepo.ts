import type { SqlExecutor } from '../db/types';
import type { SessionExercise, WorkoutSession } from '../domain/types';
import { newId } from '../lib/id';

/**
 * 行 → 实体的映射与列清单。**导出给 `backupRepo` 复用**：备份导出的行映射与仓储
 * 读数据的行映射必须是同一份，复制一份迟早会漂移，而漂移的表现是「导出的文件
 * 字段对不上」，极难排查。
 */
/** `session` 表的原始行 */
export interface SessionRow {
  id: string;
  name: string | null;
  started_at: number;
  finished_at: number | null;
  note: string | null;
}

/** `session_exercise` 表的原始行 */
export interface SessionExerciseRow {
  id: string;
  session_id: string;
  exercise_id: string;
  position: number;
  note: string | null;
}

/**
 * @param row `session` 表的行
 * @returns 领域层的 `WorkoutSession`（snake_case → camelCase）
 */
export function toSession(row: SessionRow): WorkoutSession {
  return {
    id: row.id,
    name: row.name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    note: row.note,
  };
}

/**
 * @param row `session_exercise` 表的行
 * @returns 领域层的 `SessionExercise`。**它的 id 才是组记录引用的那个 id**
 */
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

/**
 * 开一场新训练。`finishedAt` 与 `note` 一律为空 —— 新训练必然是进行中的。
 *
 * 本函数**不检查是否已有进行中的训练**：「同时只可能有一场进行中」这条不变量
 * 由 `store/activeSession.ts` 的 `startNew` 单独把守（它要先问用户
 * 「接着练还是结束它」）。绕过 store 直接调本函数，就会留下两场进行中的记录。
 *
 * @param exec SQL 执行器
 * @param name 训练名，可为 null（界面不强制命名）
 * @returns 新建的实体，含已生成的 id 与 `startedAt`（取当前时间）
 */
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

/**
 * 按 id 取一场训练。**进行中的那一场也能取到**（不像 `listSessions` 会滤掉）。
 * 总结页与历史详情页都走它。
 *
 * @param exec SQL 执行器
 * @param id `session.id`
 * @returns 训练；id 不存在时返回 null
 */
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
/**
 * @param exec SQL 执行器
 * @returns 进行中的那一场；**没有则 null**（正常情况：用户没在训练）
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

/**
 * 给训练写上结束时间，从此它出现在历史列表里。
 *
 * 只写这一列，**不碰组记录** —— 训练结束时那些 `is_completed = 0` 的占位组
 * 就留在库里，靠这个标记被各处排除掉，不需要清理。
 *
 * @param exec SQL 执行器
 * @param id 要结束的训练
 * @param finishedAt 结束时刻的时间戳，由调用方传入
 */
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

/**
 * 列出**已结束**的训练，最近的在前。
 *
 * 「只列已结束」是刻意的：进行中的那一场归 `getActiveSession` 管，
 * `startNew` 复制上次动作组合时正是靠这个过滤，才不会把进行中的训练当成"上次"。
 *
 * @param exec SQL 执行器
 * @param limit 最多返回多少场（备份导入前统计场数时传 1000）
 * @returns 训练列表，空库时是空数组
 */
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

/**
 * 往训练里追加一个动作，`position` 取当前最大值 +1（第一个动作是 0）。
 *
 * **不预建第一组** —— 那是 `store/activeSession.ts` 里
 * `addExerciseWithFirstSet` 的职责，因为它还要顺带沿用上次的重量/次数。
 * 只调本函数的话，界面上的「完成这组」会因为没有待完成的组而毫无反应。
 *
 * @param exec SQL 执行器
 * @param sessionId 目标训练
 * @param exerciseId 动作库里的动作 id
 * @returns 新建的 `SessionExercise`（它的 id 才是后面挂组用的 id）
 */
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

/**
 * 取一场训练里的动作，按 `position` 升序（即界面上的先后）。
 *
 * @param exec SQL 执行器
 * @param sessionId 目标训练
 * @returns 动作列表；没有动作时是空数组（新训练的正常状态）
 */
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

/**
 * 找出这场训练里**最近有动作的那一组**所属的 `session_exercise`。
 *
 * 用途是恢复「练到第几个动作」：`completed_at` 最大的那一组就是用户最后碰过的
 * 那组，它归属的动作就是当时停下的地方。训练里没有「当前动作」这个字段，
 * 但这件事推得出来，不值得为它加一列。
 *
 * 正在休息时结论相同 —— `startRest` 就是对刚 `completeSet` 的同一组调用的，
 * 所以不需要第二条判定。
 *
 * `st.rowid DESC` 不能省：同一毫秒完成的两组时间戳完全并列，只按 `completed_at`
 * 排序时 SQLite 会退化成按扫描顺序返回，语义就反了（`getLastPerformance` 里
 * 已经踩过同一个坑）。
 */
/**
 * @param exec SQL 执行器
 * @param sessionId 目标训练
 * @returns `session_exercise.id`；**这场一组都没完成过时返回 null**
 */
export async function findLastActiveSessionExerciseId(
  exec: SqlExecutor,
  sessionId: string,
): Promise<string | null> {
  const row = await exec.first<{ id: string }>(
    `SELECT se.id AS id
       FROM set_entry st
       JOIN session_exercise se ON se.id = st.session_exercise_id
      WHERE se.session_id = ?
        AND st.completed_at IS NOT NULL
      ORDER BY st.completed_at DESC, st.rowid DESC
      LIMIT 1`,
    [sessionId],
  );
  return row?.id ?? null;
}

/**
 * 历史列表一行所需的全部字段，**已由 SQL 聚合好**，界面不必再查组。
 *
 * 字段名与 `WorkoutSession` 不同：这里 `finishedAt` 是非空的，因为聚合只覆盖
 * 已结束的训练 —— 类型上就把「进行中」这种状态排除掉了。
 */
export interface SessionSummary {
  id: string;
  name: string | null;
  startedAt: number;
  /** 已结束的训练，finishedAt 一定非空 */
  finishedAt: number;
  /** 训练时长（分钟），由起止时间戳相减得来；负数被夹到 0 */
  durationMinutes: number;
  /** 已完成的组数；只数 `is_completed = 1` 的 */
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
/**
 * @param exec SQL 执行器
 * @param limit 最多返回多少场（历史页传 50）
 * @returns 已结束训练的摘要，最近的在前。**从没练过时是空数组**，界面据此显示空态；
 *          一场都没记录的用户不会在这里看到任何占位行
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
