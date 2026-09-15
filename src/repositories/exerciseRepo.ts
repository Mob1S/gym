import type { SqlExecutor } from '../db/types';
import type { Exercise } from '../domain/types';
import { newId } from '../lib/id';
import { SEED_EXERCISES } from './seed';

interface ExerciseRow {
  id: string;
  name: string;
  muscle_group: string | null;
  equipment: string | null;
  is_custom: number;
  is_archived: number;
  created_at: number;
}

function toExercise(row: ExerciseRow): Exercise {
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

const SELECT_COLUMNS = `
  id, name, muscle_group, equipment, is_custom, is_archived, created_at
`;

const ORDER_BY = `
  ORDER BY
    CASE muscle_group
      WHEN '胸' THEN 1 WHEN '背' THEN 2 WHEN '腿' THEN 3
      WHEN '肩' THEN 4 WHEN '手臂' THEN 5 WHEN '核心' THEN 6
      ELSE 7
    END,
    name COLLATE NOCASE
`;

export async function listExercises(exec: SqlExecutor): Promise<Exercise[]> {
  const rows = await exec.all<ExerciseRow>(
    `SELECT ${SELECT_COLUMNS} FROM exercise WHERE is_archived = 0 ${ORDER_BY}`,
  );
  return rows.map(toExercise);
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
