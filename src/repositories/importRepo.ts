import type { SqlExecutor } from '../db/types';
// **规范化入口是 importRecords，不是 csv**：`ImportedWorkout` 的定义在 csv.ts，
// 但 importRecords 把它再导出成「落库这一侧的类型契约」。这里跟着契约走，
// 将来类型换了住处（比如真的搬进 importRecords）时不必回头改这里。
import type { ImportedWorkout } from '../domain/importRecords';
import { validateImportedWorkouts, normalizeExerciseName } from '../domain/importRecords';
import { newId } from '../lib/id';
import { createCustomExercise, listExercises } from './exerciseRepo';

/**
 * 把一批「与来源无关的训练」写进库。**CSV 导入与手动补记录共用这一个入口。**
 *
 * 两条路径的差别一旦出现（比如一边写了 `completed_at`、另一边忘了），进步曲线
 * 会莫名其妙地少点，而这种 bug 极难定位 —— 所以落库只有这一条路。
 *
 * 整批跑在一个事务里。几百场训练逐条 INSERT 在手机上会读秒，事务是唯一能让它
 * 可接受的做法，顺带买到「要么全成、要么全不动」：半个文件导进去、用户却以为
 * 导完了，比直接报错糟得多。
 */

export interface ImportResult {
  /** 新建了多少场训练 */
  sessions: number;
  /** 涉及多少个不同的动作（含复用的） */
  exercises: number;
  /** 其中有多少个是这次新建的自定义动作 —— 预览与结果提示都要说这个数 */
  createdExercises: number;
}

export async function importWorkouts(
  exec: SqlExecutor,
  workouts: ImportedWorkout[],
): Promise<ImportResult> {
  const check = validateImportedWorkouts(workouts);
  if (!check.ok) throw new Error(check.reason);
  if (workouts.length === 0) {
    return { sessions: 0, exercises: 0, createdExercises: 0 };
  }

  // 动作名的匹配表一次性读进内存。**这份缓存是硬需求**：42 场训练里「卧推」
  // 可能出现 300 次，每次都查一遍库是 300 次查询；而每次各建一个新动作
  // 会让进步曲线被切成三百段。两者都不能接受。
  const byNormalizedName = new Map<string, string>();
  for (const exercise of await listExercises(exec)) {
    // 库里已有的动作也按同样的规则归一化，否则「Bench Press」与
    // 「bench press」会被当成两个
    const key = normalizeExerciseName(exercise.name);
    if (!byNormalizedName.has(key)) byNormalizedName.set(key, exercise.id);
  }

  const usedExerciseIds = new Set<string>();
  let createdExercises = 0;
  let sessionCount = 0;

  await exec.run('BEGIN');
  try {
    for (const workout of workouts) {
      const sessionId = newId();
      // `template_id` 一律为 null：导入的记录不属于任何计划，也就不会
      // 参与轮转（轮转只认 template_id 非空的场次）
      await exec.run(
        `INSERT INTO session (id, name, started_at, finished_at, note, template_id)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
        [sessionId, workout.name, workout.startedAt, workout.finishedAt],
      );
      sessionCount += 1;

      // 同一场里同名的动作合并到一个 session_exercise 上
      const merged = new Map<string, { name: string; sets: typeof workout.exercises[number]['sets'] }>();
      for (const item of workout.exercises) {
        const key = normalizeExerciseName(item.name);
        const existing = merged.get(key);
        if (existing) {
          existing.sets.push(...item.sets);
        } else {
          merged.set(key, { name: item.name, sets: [...item.sets] });
        }
      }

      let sessionExercisePosition = 0;
      for (const [key, item] of merged) {
        let exerciseId = byNormalizedName.get(key);
        if (!exerciseId) {
          const created = await createCustomExercise(exec, item.name, null, null);
          exerciseId = created.id;
          byNormalizedName.set(key, exerciseId);
          createdExercises += 1;
        }
        usedExerciseIds.add(exerciseId);

        const sessionExerciseId = newId();
        await exec.run(
          `INSERT INTO session_exercise (id, session_id, exercise_id, position, note)
           VALUES (?, ?, ?, ?, NULL)`,
          [sessionExerciseId, sessionId, exerciseId, sessionExercisePosition],
        );
        sessionExercisePosition += 1;

        for (const [index, set] of item.sets.entries()) {
          await exec.run(
            `INSERT INTO set_entry
               (id, session_exercise_id, position, weight, reps, is_completed, rest_seconds, rest_started_at, completed_at)
             VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?)`,
            [
              newId(),
              sessionExerciseId,
              index,
              set.weight,
              set.reps,
              // 没有真实的完成时刻数据，用这一场的结束时间。它只影响
              // 「最近碰过哪一组」这类推导，而导入的场次已经结束、不会被 resume
              workout.finishedAt,
            ],
          );
        }
      }
    }
    await exec.run('COMMIT');
  } catch (error) {
    // 回滚自身也可能抛（连接已断之类）。调用方更需要知道「导入为什么失败」，
    // 所以回滚的异常吞掉，抛出去的必须是原始异常 —— 不换成自己的错误。
    try {
      await exec.run('ROLLBACK');
    } catch {
      // 忽略：下面抛原始异常
    }
    throw error;
  }

  return {
    sessions: sessionCount,
    exercises: usedExerciseIds.size,
    createdExercises,
  };
}
