import type { SqlExecutor } from '../db/types';
import type { Exercise } from '../domain/types';
import { newId } from '../lib/id';
import { SEED_EXERCISES } from './seed';

/**
 * 行 → 实体的映射。**导出给 `backupRepo` 复用**：备份导出的行映射与仓储读数据的
 * 行映射必须是同一份，复制一份迟早会漂移，而漂移的表现是「导出的文件字段对不上」，
 * 极难排查。
 */
export interface ExerciseRow {
  id: string;
  name: string;
  muscle_group: string | null;
  equipment: string | null;
  is_custom: number;
  is_archived: number;
  created_at: number;
}

export function toExercise(row: ExerciseRow): Exercise {
  return {
    id: row.id,
    name: row.name,
    muscleGroup: row.muscle_group,
    equipment: row.equipment,
    isCustom: row.is_custom === 1,
    isArchived: row.is_archived === 1,
    createdAt: row.created_at,
  };
}

/** 同样导出给 `backupRepo` 复用，保证 SELECT 的列与上面的映射永远对得上 */
export const SELECT_COLUMNS = `
  id, name, muscle_group, equipment, is_custom, is_archived, created_at
`;

/** 肌群的展示顺序。不在这个表里的肌群一律排到最后。 */
const MUSCLE_GROUP_ORDER = ['胸', '背', '腿', '肩', '手臂', '核心'];

function muscleGroupRank(group: string | null): number {
  const index = MUSCLE_GROUP_ORDER.indexOf(group ?? '');
  return index === -1 ? MUSCLE_GROUP_ORDER.length : index;
}

/**
 * 按肌群、再按动作名排序。
 *
 * **名称必须在这里用 localeCompare('zh') 排，不能交给 SQLite。**
 * SQLite 的 `COLLATE NOCASE` 只做 ASCII 大小写折叠，对中文退化为 UTF-8 码点比较，
 * 排出来是「保加利亚分腿蹲、前蹲、坐姿提踵、深蹲、硬拉…」这种对人来说毫无规律的顺序。
 * JS 的 localeCompare('zh') 走 ICU 拼音序，才是中文用户预期的「按字母排」。
 *
 * 实测：SQLite 的 `name COLLATE NOCASE` / `name` / `name COLLATE BINARY` 三者结果
 * 与 JS 默认 `.sort()` 完全一致，与 `localeCompare('zh')` 全部不同。
 */
function compareExercises(a: Exercise, b: Exercise): number {
  const rankDiff =
    muscleGroupRank(a.muscleGroup) - muscleGroupRank(b.muscleGroup);
  if (rankDiff !== 0) return rankDiff;
  return a.name.localeCompare(b.name, 'zh');
}

export async function listExercises(exec: SqlExecutor): Promise<Exercise[]> {
  const rows = await exec.all<ExerciseRow>(
    `SELECT ${SELECT_COLUMNS} FROM exercise WHERE is_archived = 0`,
  );
  return rows.map(toExercise).sort(compareExercises);
}

export async function getExercise(
  exec: SqlExecutor,
  id: string,
): Promise<Exercise | null> {
  const row = await exec.first<ExerciseRow>(
    `SELECT ${SELECT_COLUMNS} FROM exercise WHERE id = ?`,
    [id],
  );
  return row ? toExercise(row) : null;
}

export async function createCustomExercise(
  exec: SqlExecutor,
  name: string,
  muscleGroup: string | null,
  equipment: string | null,
): Promise<Exercise> {
  const exercise: Exercise = {
    id: newId(),
    name,
    muscleGroup,
    equipment,
    isCustom: true,
    isArchived: false,
    createdAt: Date.now(),
  };

  await exec.run(
    `INSERT INTO exercise (id, name, muscle_group, equipment, is_custom, is_archived, created_at)
     VALUES (?, ?, ?, ?, 1, 0, ?)`,
    [
      exercise.id,
      exercise.name,
      exercise.muscleGroup,
      exercise.equipment,
      exercise.createdAt,
    ],
  );

  return exercise;
}

/**
 * 只在动作表为空时写入预置动作。
 * 判断依据是「表里一个动作都没有」，而不是「表里没有预置动作」——
 * 用户如果自己先建了动作，就不该再塞一堆预置动作进去。
 */
export async function seedExercisesIfEmpty(exec: SqlExecutor): Promise<void> {
  const row = await exec.first<{ count: number }>(
    'SELECT COUNT(*) AS count FROM exercise',
  );
  if (row && row.count > 0) return;

  const now = Date.now();
  for (const item of SEED_EXERCISES) {
    await exec.run(
      `INSERT INTO exercise (id, name, muscle_group, equipment, is_custom, is_archived, created_at)
       VALUES (?, ?, ?, ?, 0, 0, ?)`,
      [newId(), item.name, item.muscleGroup, item.equipment, now],
    );
  }
}
