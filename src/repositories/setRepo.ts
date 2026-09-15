import type { SqlExecutor } from '../db/types';
import type { SetEntry } from '../domain/types';
import { newId } from '../lib/id';

interface SetRow {
  id: string;
  session_exercise_id: string;
  position: number;
  weight: number;
  reps: number;
  is_completed: number;
  rest_seconds: number | null;
  rest_started_at: number | null;
  completed_at: number | null;
}

function toSetEntry(row: SetRow): SetEntry {
  return {
    id: row.id,
    sessionExerciseId: row.session_exercise_id,
    position: row.position,
    weight: row.weight,
    reps: row.reps,
    isCompleted: row.is_completed === 1,
    restSeconds: row.rest_seconds,
    restStartedAt: row.rest_started_at,
    completedAt: row.completed_at,
  };
}

const SELECT_COLUMNS = `
  id, session_exercise_id, position, weight, reps,
  is_completed, rest_seconds, rest_started_at, completed_at
`;

/**
 * 与上面同一组列，但带 `st.` 前缀。
 *
 * `set_entry` 与 `session_exercise` 都有 `id` 和 `position`，凡是 JOIN 了
 * `session_exercise` 的查询都必须用带前缀的版本，否则 SQLite 直接报
 * `ambiguous column name: id`（实测：prepare 阶段就抛，不是取数阶段）。
 */
const SELECT_COLUMNS_PREFIXED = `
  st.id, st.session_exercise_id, st.position, st.weight, st.reps,
  st.is_completed, st.rest_seconds, st.rest_started_at, st.completed_at
`;

export async function addSet(
  exec: SqlExecutor,
  sessionExerciseId: string,
  weight: number,
  reps: number,
): Promise<SetEntry> {
  const row = await exec.first<{ next: number | null }>(
    'SELECT MAX(position) + 1 AS next FROM set_entry WHERE session_exercise_id = ?',
    [sessionExerciseId],
  );
  const position = row?.next ?? 0;

  const set: SetEntry = {
    id: newId(),
    sessionExerciseId,
    position,
    weight,
    reps,
    isCompleted: false,
    restSeconds: null,
    restStartedAt: null,
    completedAt: null,
  };

  await exec.run(
    `INSERT INTO set_entry
       (id, session_exercise_id, position, weight, reps, is_completed, rest_seconds, rest_started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL)`,
    [set.id, sessionExerciseId, position, weight, reps],
  );

  return set;
}

export async function listSets(
  exec: SqlExecutor,
  sessionExerciseId: string,
): Promise<SetEntry[]> {
  const rows = await exec.all<SetRow>(
    `SELECT ${SELECT_COLUMNS} FROM set_entry
     WHERE session_exercise_id = ?
     ORDER BY position ASC`,
    [sessionExerciseId],
  );
  return rows.map(toSetEntry);
}

/**
 * 改写某一组的重量与次数。
 *
 * 记录界面在「完成这一组」时会先把用户当前填的数值写进来，再标记完成——
 * 顺序反过来的话，中途失败就会留下一条「已完成但数值是旧的」的记录。
 *
 * 之所以在这里开一个函数，而不是让 store 直接 `exec.run(...)`：全局约束规定
 * 界面层的数据访问只能经过仓储层，store 也不例外。SQL 一旦散布到 store 里，
 * 将来加云同步就得同时改两处。
 */
export async function updateSetValues(
  exec: SqlExecutor,
  setId: string,
  weight: number,
  reps: number,
): Promise<void> {
  await exec.run('UPDATE set_entry SET weight = ?, reps = ? WHERE id = ?', [
    weight,
    reps,
    setId,
  ]);
}

/**
 * 标记一组已完成。**这一步必须立刻落盘**——训练记录的全部价值就在于不丢，
 * 不能等训练结束再统一保存。
 */
export async function completeSet(
  exec: SqlExecutor,
  setId: string,
  completedAt: number,
): Promise<void> {
  await exec.run(
    'UPDATE set_entry SET is_completed = 1, completed_at = ? WHERE id = ?',
    [completedAt, setId],
  );
}

/** 开始休息计时：只记时间戳，之后用「现在 − 这个时间戳」算时长 */
export async function startRest(
  exec: SqlExecutor,
  setId: string,
  at: number,
): Promise<void> {
  await exec.run('UPDATE set_entry SET rest_started_at = ? WHERE id = ?', [
    at,
    setId,
  ]);
}

/**
 * 结束休息计时，写入这段休息的秒数。
 * 必须基于 rest_started_at 做时间戳相减，而不是用计数器累加——
 * App 被系统挂起后计数器会停，时间戳不会。
 */
export async function endRest(
  exec: SqlExecutor,
  setId: string,
  at: number,
): Promise<void> {
  const row = await exec.first<{ rest_started_at: number | null }>(
    'SELECT rest_started_at FROM set_entry WHERE id = ?',
    [setId],
  );

  if (!row || row.rest_started_at === null) return;

  const seconds = Math.max(0, Math.round((at - row.rest_started_at) / 1000));
  await exec.run(
    'UPDATE set_entry SET rest_seconds = ?, rest_started_at = NULL WHERE id = ?',
    [seconds, setId],
  );
}

/**
 * 放弃一段休息：清掉 `rest_started_at`，且**不写入 `rest_seconds`**。
 *
 * 用于「这段休息跑了太久，显然是忘了按开始下一组」的情况。它和 `endRest`
 * 的区别是刻意的：那种时长不是真实休息，不该作为数据留下来 —— 休息建议
 * 规则要算平均休息时长，一条 8 小时的记录足以把平均值彻底带偏。
 */
export async function cancelRest(
  exec: SqlExecutor,
  setId: string,
): Promise<void> {
  await exec.run('UPDATE set_entry SET rest_started_at = NULL WHERE id = ?', [
    setId,
  ]);
}

/**
 * 取某个动作在**更早的某一次训练**里的完成组，用于在记录界面上显示「上次练了多少」。
 *
 * 只取最近一次有该动作的训练：更早的数据对「这次该加多少」没有参考价值，
 * 混在一起反而会干扰。
 *
 * **`s.rowid DESC` 这个并列项不能省。** `started_at` 只有毫秒精度，两场训练完全
 * 可能落在同一毫秒里（实测：连续调用两次 `createSession`，两行的 `started_at`
 * 都是 1789463457151）。此时只写 `ORDER BY s.started_at DESC`，SQLite 会按扫描
 * 顺序返回，也就是**先插入的那一场**——正是「更早」的那一场，语义整个反了。
 * rowid 就是插入顺序，用它兜底才能保证「取最新」。
 */
export async function getLastPerformance(
  exec: SqlExecutor,
  exerciseId: string,
  beforeSessionId: string,
): Promise<SetEntry[]> {
  const previous = await exec.first<{ id: string }>(
    `SELECT s.id AS id
       FROM session s
       JOIN session_exercise se ON se.session_id = s.id
      WHERE se.exercise_id = ?
        AND s.id <> ?
        AND s.finished_at IS NOT NULL
      ORDER BY s.started_at DESC, s.rowid DESC
      LIMIT 1`,
    [exerciseId, beforeSessionId],
  );

  if (!previous) return [];

  const rows = await exec.all<SetRow>(
    `SELECT ${SELECT_COLUMNS_PREFIXED}
       FROM set_entry st
       JOIN session_exercise se ON se.id = st.session_exercise_id
      WHERE se.exercise_id = ?
        AND se.session_id = ?
        AND st.is_completed = 1
      ORDER BY st.position ASC`,
    [exerciseId, previous.id],
  );

  return rows.map(toSetEntry);
}
