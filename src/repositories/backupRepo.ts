import type { SqlExecutor } from '../db/types';
import { SCHEMA_VERSION } from '../db/types';
import { buildBackup } from '../domain/backup';
import type { BackupFile } from '../domain/backup';
import { SELECT_COLUMNS as EXERCISE_COLUMNS, toExercise, type ExerciseRow } from './exerciseRepo';
import {
  SESSION_COLUMNS,
  SESSION_EXERCISE_COLUMNS,
  toSession,
  toSessionExercise,
  type SessionExerciseRow,
  type SessionRow,
} from './sessionRepo';
import { SELECT_COLUMNS as SET_COLUMNS, toSetEntry, type SetRow } from './setRepo';
import {
  toTemplate,
  toTemplateExercise,
  type TemplateExerciseRow,
  type TemplateRow,
} from './templateRepo';

/**
 * 备份的导出与导入。
 *
 * 导入的语义是**整库替换**，所以「要么全成功、要么全不动」是硬要求 ——
 * 整个导入跑在一个事务里，中途任何一步抛错都回滚，并把原始异常原样抛给调用方。
 *
 * 行映射（`toExercise` / `toSession` / …）与列清单一律从各仓储 import，**不在这里
 * 重写**：两份映射迟早会漂移，而漂移的表现是「导出的文件字段对不上」，极难排查。
 */

/** 布尔值要显式转成 0/1：SQLite 不认 JS 的 true/false */
/**
 * @param value 布尔值
 * @returns 1 或 0，可直接当 SQL 参数绑定
 */
function flag(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * 导出整库。
 *
 * 六张表**都按 `rowid` 升序导出**，也就是插入顺序。这不是为了好看：
 * 历史列表用 `ORDER BY started_at DESC, rowid DESC` 排序，`started_at` 只有毫秒
 * 精度，同一毫秒建的两场训练谁在前**完全由插入顺序决定**。导出若按 id 之类的顺序
 * 排，恢复出来的历史顺序就会跟原来不一样。`rowid` 是唯一能还原「原来谁在前」的东西。
 */
/**
 * @param exec SQL 执行器
 * @returns 一份完整备份（`domain/backup.ts` 的 `buildBackup` 组装）；
 *          **空库也会正常返回**，只是六个数组都是空的 —— 空备份是合法的，
 *          导入它等于清空
 */
export async function exportAll(exec: SqlExecutor): Promise<BackupFile> {
  const exercises = (
    await exec.all<ExerciseRow>(`SELECT ${EXERCISE_COLUMNS} FROM exercise ORDER BY rowid ASC`)
  ).map(toExercise);

  const sessions = (
    await exec.all<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM session ORDER BY rowid ASC`)
  ).map(toSession);

  const sessionExercises = (
    await exec.all<SessionExerciseRow>(
      `SELECT ${SESSION_EXERCISE_COLUMNS} FROM session_exercise ORDER BY rowid ASC`,
    )
  ).map(toSessionExercise);

  const sets = (
    await exec.all<SetRow>(`SELECT ${SET_COLUMNS} FROM set_entry ORDER BY rowid ASC`)
  ).map(toSetEntry);

  // 计划两张表也用 rowid 升序：`position` 相同时（理论上不该有，但导入的
  // 备份可能带进来）谁在前只能靠插入顺序还原。
  const templates = (
    await exec.all<TemplateRow>(
      'SELECT id, name, position, created_at FROM split_template ORDER BY rowid ASC',
    )
  ).map(toTemplate);

  const templateExercises = (
    await exec.all<TemplateExerciseRow>(
      'SELECT id, template_id, exercise_id, position FROM template_exercise ORDER BY rowid ASC',
    )
  ).map(toTemplateExercise);

  return buildBackup(
    { exercises, sessions, sessionExercises, sets, templates, templateExercises },
    SCHEMA_VERSION,
    Date.now(),
  );
}

/**
 * 用一份备份**整体替换**库里的数据。调用方必须先用 `validateBackup` 校验过，
 * 这里假定数据是合法的，只管写。
 *
 * 顺序不能改：
 * - 删除与外键方向相反（`set_entry → session_exercise → session →
 *   template_exercise → split_template → exercise`），反过来删会撞外键 ——
 *   `session_exercise.exercise_id` 与 `template_exercise.exercise_id` 都引用
 *   `exercise(id)`，所以两张「动作引用表」都必须排在 `exercise` 之前。
 *   动作库也要一起换掉：备份里带着自定义动作，这样换设备后它们不会丢。
 * - 插入与外键方向相同（`exercises → templates → templateExercises →
 *   sessions → sessionExercises → sets`）。`template_exercise.template_id` 引用
 *   `split_template(id)`，所以计划要先于它的动作；`session.template_id` 没有外键
 *   （见 `schema.ts`），顺序无所谓，但放在 `sessions` 之前更符合直觉。
 *
 * `position` 一律按备份里的值原样写入，**不重新编号** —— 重新编号会让「第几个动作」
 * 和用户记忆里的对不上。
 */
/**
 * @param exec SQL 执行器
 * @param backup **必须已经过 `validateBackup`** 的备份对象；本函数不再校验。
 *        v1 的老备份对象里没有计划两张表的字段（类型上不是可选的），
 *        这里按空数组兜底，与 `validateBackup` 的读法一致
 * @returns 事务提交后 resolve
 * @throws 任何一步失败时抛出**原始异常**（已回滚，库里数据未改动）。
 *         回滚自身的异常会被吞掉，保证调用方拿到的始终是「为什么失败」
 */
export async function importAll(exec: SqlExecutor, backup: BackupFile): Promise<void> {
  const {
    exercises,
    sessions,
    sessionExercises,
    sets,
    templates = [],
    templateExercises = [],
  } = backup.data;

  await exec.run('BEGIN');
  try {
    await exec.run('DELETE FROM set_entry');
    await exec.run('DELETE FROM session_exercise');
    await exec.run('DELETE FROM session');
    await exec.run('DELETE FROM template_exercise');
    await exec.run('DELETE FROM split_template');
    await exec.run('DELETE FROM exercise');

    for (const exercise of exercises) {
      await exec.run(
        `INSERT INTO exercise (id, name, muscle_group, equipment, is_custom, is_archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          exercise.id,
          exercise.name,
          exercise.muscleGroup,
          exercise.equipment,
          flag(exercise.isCustom),
          flag(exercise.isArchived),
          exercise.createdAt,
        ],
      );
    }

    for (const template of templates) {
      await exec.run(
        'INSERT INTO split_template (id, name, position, created_at) VALUES (?, ?, ?, ?)',
        [template.id, template.name, template.position, template.createdAt],
      );
    }

    for (const templateExercise of templateExercises) {
      await exec.run(
        `INSERT INTO template_exercise (id, template_id, exercise_id, position)
         VALUES (?, ?, ?, ?)`,
        [
          templateExercise.id,
          templateExercise.templateId,
          templateExercise.exerciseId,
          templateExercise.position,
        ],
      );
    }

    for (const session of sessions) {
      await exec.run(
        `INSERT INTO session (id, name, started_at, finished_at, note, template_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          session.name,
          session.startedAt,
          session.finishedAt,
          session.note,
          // v1 的老备份对象里没有这个字段，是 undefined；而 node:sqlite 对
          // undefined 是**直接抛错**（不是当 NULL），所以显式兜成 null。
          // 「老备份一定能导入」这条不能只靠 validateBackup 一侧守住。
          session.templateId ?? null,
        ],
      );
    }

    for (const sessionExercise of sessionExercises) {
      await exec.run(
        `INSERT INTO session_exercise (id, session_id, exercise_id, position, note)
         VALUES (?, ?, ?, ?, ?)`,
        [
          sessionExercise.id,
          sessionExercise.sessionId,
          sessionExercise.exerciseId,
          sessionExercise.position,
          sessionExercise.note,
        ],
      );
    }

    for (const set of sets) {
      await exec.run(
        `INSERT INTO set_entry
           (id, session_exercise_id, position, weight, reps, is_completed, rest_seconds, rest_started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          set.id,
          set.sessionExerciseId,
          set.position,
          set.weight,
          set.reps,
          flag(set.isCompleted),
          set.restSeconds,
          set.restStartedAt,
          set.completedAt,
        ],
      );
    }

    await exec.run('COMMIT');
  } catch (error) {
    // 回滚本身也可能抛（连接已断之类）。那种情况下调用方更需要知道「导入为什么失败」，
    // 所以回滚的异常吞掉，抛出去的必须是原始异常 —— 不换成自己的错误。
    try {
      await exec.run('ROLLBACK');
    } catch {
      // 忽略：下面抛原始异常
    }
    throw error;
  }
}
