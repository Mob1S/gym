import type { SqlExecutor } from '../db/types';
import type { Exercise } from '../domain/types';
import { newId } from '../lib/id';
import { SEED_EXERCISES } from './seed';

/**
 * 行 → 实体的映射。**导出给 `backupRepo` 复用**：备份导出的行映射与仓储读数据的
 * 行映射必须是同一份，复制一份迟早会漂移，而漂移的表现是「导出的文件字段对不上」，
 * 极难排查。
 */
/** `exercise` 表的原始行。布尔在库里是 0/1，转换见 `toExercise` */
export interface ExerciseRow {
  id: string;
  name: string;
  muscle_group: string | null;
  equipment: string | null;
  is_custom: number;
  is_archived: number;
  created_at: number;
}

/**
 * 行 → 实体。snake_case 转 camelCase，并把 0/1 还原成布尔。
 *
 * @param row `exercise` 表的行
 * @returns 领域层的 `Exercise`
 */
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

/**
 * @param group 肌群名
 * @returns 它在展示顺序里的名次；**不在 `MUSCLE_GROUP_ORDER` 里的（含 null）
 *          一律排到最后**，而不是排到最前
 */
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
/**
 * @param a 待比较的动作
 * @param b 待比较的动作
 * @returns 负数/0/正数，语义同 `Array.prototype.sort` 的比较器：
 *          先按肌群名次，同肌群再按名称的拼音序
 */
function compareExercises(a: Exercise, b: Exercise): number {
  const rankDiff =
    muscleGroupRank(a.muscleGroup) - muscleGroupRank(b.muscleGroup);
  if (rankDiff !== 0) return rankDiff;
  return a.name.localeCompare(b.name, 'zh');
}

/**
 * 列出全部**未归档**的动作，已按肌群 + 拼音排好序。
 *
 * 排序在 JS 里做而不是 SQL 里，原因见 `compareExercises` 的注释。
 *
 * @param exec SQL 执行器
 * @returns 动作列表；空库时是空数组（正常流程下 `seedExercisesIfEmpty` 已播过种）
 */
export async function listExercises(exec: SqlExecutor): Promise<Exercise[]> {
  const rows = await exec.all<ExerciseRow>(
    `SELECT ${SELECT_COLUMNS} FROM exercise WHERE is_archived = 0`,
  );
  return rows.map(toExercise).sort(compareExercises);
}

/**
 * 按 id 取一个动作。
 *
 * @param exec SQL 执行器
 * @param id `exercise.id`
 * @returns 动作；**id 不存在时返回 null**。注意已归档的动作也能取到 ——
 *          历史记录里引用着它，取不到就会显示成「未知动作」
 */
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

/**
 * 新建一个用户自建动作（`isCustom` 一律为 true，预置动作只能由播种写入）。
 *
 * 不做重名检查：动作库里本来就有「卧推 / 上斜卧推 / 窄距卧推」这类同名前缀，
 * 判断重名比让用户自己看更烦人。
 *
 * @param exec SQL 执行器
 * @param name 动作名，调用方需保证非空
 * @param muscleGroup 肌群；null 表示未指定，会排到列表最后
 * @param equipment 器械；null 表示未指定
 * @returns 新建出来的实体（含已生成的 id 与 createdAt），**不再回头查库**
 */
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
/**
 * @param exec SQL 执行器
 * @returns 播种完成（或本来就非空、直接返回）后 resolve；无返回值
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
