import type { SqlExecutor } from '../db/types';

/**
 * 进步页的原始点：一条**已完成**的组，连带它属于哪个动作、哪一场训练。
 *
 * 这个形状天然满足 `domain/progress.ts` 的 `SetPointInput`，因此可以直接
 * 喂给 `buildProgressPoints` —— 仓储与 domain 之间不需要再有一层转换。
 */
export interface CompletedSetPoint {
  /** 属于哪个动作；首屏查全部动作时一个结果里会混着多个动作 */
  exerciseId: string;
  sessionId: string;
  /** 该场训练的开始时间，用作曲线横轴 */
  startedAt: number;
  /** 重量（kg） */
  weight: number;
  reps: number;
}

/** 进步页首屏列表的一行：一个练过的动作 + 最近一次练它的时间 */
export interface TrainedExercise {
  exerciseId: string;
  /** 动作名，直接取自 `exercise` 表，免去界面再查一次 */
  name: string;
  /** 最近一次**已结束**训练里练到它的时间，列表按它倒序 */
  lastTrainedAt: number;
}

/** 聚合查询的原始行（列名是 SQL 别名，转换见 `listCompletedSetPoints`） */
interface CompletedSetRow {
  exercise_id: string;
  session_id: string;
  started_at: number;
  weight: number;
  reps: number;
}

/**
 * 进步页的全部原始数据：**已完成、且属于一场已结束的训练**的组。
 *
 * 两个条件都不是可选的：
 * - `is_completed = 1` —— 没完成的那一组是记录界面预建的占位，不是训练量。
 * - `finished_at IS NOT NULL` —— 正在进行的训练不进「进步」页，和历史页只列
 *   已结束训练是同一条约定。没有它，用户练到一半切过来会看到曲线末尾多一个
 *   还在变的点。
 *
 * `exerciseId` 可选是刻意的：**首屏不传、详情页传**。首屏要画每个动作的迷你
 * 走势，本来就缺不了完整序列；对 20 个动作查 20 次就是 N+1（`listSessionSummaries`
 * 的注释里写过「N+1 查询在手机上会肉眼可见地卡」）。一份 SQL 两个调用方，
 * 好过把同一段 JOIN 抄两遍。
 *
 * `ORDER BY` 里的 `s.rowid` 与 `st.position` 都不能省：`started_at` 只有毫秒
 * 精度，同一毫秒建的两场训练会完全并列，此时 SQLite 按扫描顺序返回，语义就反了。
 */
/**
 * @param exec SQL 执行器
 * @param exerciseId 只取这个动作的组；**省略则取全部动作**（首屏画迷你走势用）
 * @returns 已完成组，按「训练时间升序 → 同场内按组序」排列 ——
 *          这个顺序正是 `buildProgressPoints` 分组后需要的顺序
 */
export async function listCompletedSetPoints(
  exec: SqlExecutor,
  exerciseId?: string,
): Promise<CompletedSetPoint[]> {
  const params: unknown[] = [];
  let filter = '';
  if (exerciseId !== undefined) {
    filter = 'AND se.exercise_id = ?';
    params.push(exerciseId);
  }

  const rows = await exec.all<CompletedSetRow>(
    `SELECT se.exercise_id AS exercise_id,
            s.id           AS session_id,
            s.started_at   AS started_at,
            st.weight      AS weight,
            st.reps        AS reps
       FROM set_entry st
       JOIN session_exercise se ON se.id = st.session_exercise_id
       JOIN session s          ON s.id  = se.session_id
      WHERE st.is_completed = 1
        AND s.finished_at IS NOT NULL
        ${filter}
      ORDER BY s.started_at ASC, s.rowid ASC, st.position ASC`,
    params,
  );

  return rows.map((row) => ({
    exerciseId: row.exercise_id,
    sessionId: row.session_id,
    startedAt: row.started_at,
    weight: row.weight,
    reps: row.reps,
  }));
}

/**
 * 「进步」页首屏的动作列表：练过的动作 + 最近一次的时间。
 *
 * 用聚合而不是「查完所有点再在 JS 里筛动作」，是因为这里只需要两个字段；
 * 但排序规则必须和 `listCompletedSetPoints` 的结果对得上 —— 两边都只认
 * 「已完成 + 已结束」，否则列表里会出现一个点都画不出来的动作。
 */
/**
 * @param exec SQL 执行器
 * @returns 练过的动作，最近的在前；同一时间并列时按动作名升序。
 *          **没练过的动作不会出现**，因此界面不必为空点做兜底
 */
export async function listTrainedExercises(
  exec: SqlExecutor,
): Promise<TrainedExercise[]> {
  const rows = await exec.all<{
    exercise_id: string;
    name: string;
    last_trained_at: number;
  }>(
    `SELECT se.exercise_id    AS exercise_id,
            e.name            AS name,
            MAX(s.started_at) AS last_trained_at
       FROM set_entry st
       JOIN session_exercise se ON se.id = st.session_exercise_id
       JOIN session s          ON s.id  = se.session_id
       JOIN exercise e         ON e.id  = se.exercise_id
      WHERE st.is_completed = 1
        AND s.finished_at IS NOT NULL
      GROUP BY se.exercise_id, e.name
      ORDER BY last_trained_at DESC, e.name ASC`,
  );

  return rows.map((row) => ({
    exerciseId: row.exercise_id,
    name: row.name,
    lastTrainedAt: row.last_trained_at,
  }));
}
