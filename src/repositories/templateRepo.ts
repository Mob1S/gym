import type { SqlExecutor } from '../db/types';
import type { SplitTemplate, TemplateExercise } from '../domain/types';
import { newId } from '../lib/id';

/**
 * 分化计划（训练模板）的读写。
 *
 * 计划的动作清单只有**整体覆盖**一个写入口（`setTemplateExercises`），没有
 * 「加一个/删一个/挪一位」这种细粒度接口：编辑界面就是「本地改一份数组 →
 * 保存时整体覆盖」，比逐个 diff（加哪个、删哪个、谁排第几）简单一个量级，
 * 而且不会出现半应用状态。少一个接口就少一类不同步的 bug。
 */

/** `split_template` 表的原始行。**导出给 `backupRepo` 复用** */
export interface TemplateRow {
  id: string;
  name: string;
  position: number;
  created_at: number;
}

/** `template_exercise` 表的原始行。**导出给 `backupRepo` 复用** */
export interface TemplateExerciseRow {
  id: string;
  template_id: string;
  exercise_id: string;
  position: number;
}

/**
 * @param row `split_template` 表的行
 * @returns 领域层的 `SplitTemplate`（snake_case → camelCase）
 */
export function toTemplate(row: TemplateRow): SplitTemplate {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    createdAt: row.created_at,
  };
}

/**
 * @param row `template_exercise` 表的行
 * @returns 领域层的 `TemplateExercise`
 */
export function toTemplateExercise(row: TemplateExerciseRow): TemplateExercise {
  return {
    id: row.id,
    templateId: row.template_id,
    exerciseId: row.exercise_id,
    position: row.position,
  };
}

/** 计划 + 动作数。列表页要用，见 `listTemplates` */
export interface TemplateSummary extends SplitTemplate {
  /** 这个计划里有几个动作；一次聚合查出来，避免列表页 N+1 */
  exerciseCount: number;
}

/** 一个计划 + 它的动作清单（已带动作名） */
export interface TemplateDetail {
  template: SplitTemplate;
  /** 顺序即 `position` 顺序；动作名在这里就查好，界面不必再查一次 */
  exercises: { templateExercise: TemplateExercise; exerciseName: string }[];
}

/**
 * 列出全部计划，按轮转顺序。
 *
 * 用一次 LEFT JOIN + GROUP BY 把动作数带回来，而不是「查完计划再逐个查动作数」：
 * 设置页要把所有计划一次列出来，N+1 查询在手机上会肉眼可见地卡
 * （`listSessionSummaries` 的注释里写过同一件事）。
 *
 * @param exec SQL 执行器
 * @returns 全部计划，`position` 升序；**一个计划都没有时是空数组**，
 *   界面据此显示「还没有计划」并引导新建
 */
export async function listTemplates(
  exec: SqlExecutor,
): Promise<TemplateSummary[]> {
  const rows = await exec.all<TemplateRow & { exercise_count: number }>(
    `SELECT t.id         AS id,
            t.name       AS name,
            t.position   AS position,
            t.created_at AS created_at,
            COUNT(te.id) AS exercise_count
       FROM split_template t
       LEFT JOIN template_exercise te ON te.template_id = t.id
      GROUP BY t.id
      ORDER BY t.position ASC, t.rowid ASC`,
  );

  return rows.map((row) => ({
    ...toTemplate(row),
    exerciseCount: Number(row.exercise_count),
  }));
}

/**
 * 取一个计划连同它的动作清单。
 *
 * 动作名一步 JOIN 出来：调用方（编辑界面、预览）无一例外都要显示名字，
 * 让它们各自再 `getExercise` 一次既啰嗦又容易漏。
 *
 * @param exec SQL 执行器
 * @param id `split_template.id`
 * @returns 计划与动作；**id 不存在时返回 null**（调用方据此显示「这个计划不存在」）
 */
export async function getTemplate(
  exec: SqlExecutor,
  id: string,
): Promise<TemplateDetail | null> {
  const templateRow = await exec.first<TemplateRow>(
    'SELECT id, name, position, created_at FROM split_template WHERE id = ?',
    [id],
  );
  if (!templateRow) return null;

  const exerciseRows = await exec.all<TemplateExerciseRow & { exercise_name: string }>(
    `SELECT te.id          AS id,
            te.template_id AS template_id,
            te.exercise_id AS exercise_id,
            te.position    AS position,
            e.name         AS exercise_name
       FROM template_exercise te
       JOIN exercise e ON e.id = te.exercise_id
      WHERE te.template_id = ?
      ORDER BY te.position ASC, te.rowid ASC`,
    [id],
  );

  return {
    template: toTemplate(templateRow),
    exercises: exerciseRows.map((row) => ({
      templateExercise: toTemplateExercise(row),
      exerciseName: row.exercise_name,
    })),
  };
}

/**
 * 新建一个空计划，排在最后。
 *
 * @param exec SQL 执行器
 * @param name 计划名，调用方需保证非空（界面上空名字会退回「新计划」）
 * @returns 新建的计划；**一个动作也没有**，由编辑界面引导用户加
 */
export async function createTemplate(
  exec: SqlExecutor,
  name: string,
): Promise<SplitTemplate> {
  const row = await exec.first<{ next: number | null }>(
    'SELECT MAX(position) + 1 AS next FROM split_template',
  );

  const template: SplitTemplate = {
    id: newId(),
    name,
    position: row?.next ?? 0,
    createdAt: Date.now(),
  };

  await exec.run(
    'INSERT INTO split_template (id, name, position, created_at) VALUES (?, ?, ?, ?)',
    [template.id, template.name, template.position, template.createdAt],
  );

  return template;
}

/**
 * 改计划名。
 *
 * @param exec SQL 执行器
 * @param id 目标计划
 * @param name 新名字
 */
export async function renameTemplate(
  exec: SqlExecutor,
  id: string,
  name: string,
): Promise<void> {
  await exec.run('UPDATE split_template SET name = ? WHERE id = ?', [name, id]);
}

/**
 * 整个替换一个计划的动作清单与顺序。
 *
 * **先删后插**，在一个事务里：删一半插一半失败的话，用户会得到一个半残的计划，
 * 而他在界面上看到的仍然是自己编排好的那份，下次进来才发现少了一半。
 *
 * 允许同一个动作重复出现（有人真的会练两轮），所以每次插入都用 `newId()` 生成
 * 新的 `template_exercise.id`，不能拿 `exerciseId` 当 id。
 *
 * @param exec SQL 执行器
 * @param id 目标计划
 * @param exerciseIds 动作库里的动作 id，**数组顺序就是计划里的顺序**
 * @returns 覆盖之后的计划详情（界面直接拿它刷新，不必再查一次）
 */
export async function setTemplateExercises(
  exec: SqlExecutor,
  id: string,
  exerciseIds: string[],
): Promise<TemplateDetail> {
  await exec.run('BEGIN');
  try {
    await exec.run('DELETE FROM template_exercise WHERE template_id = ?', [id]);
    for (const [index, exerciseId] of exerciseIds.entries()) {
      await exec.run(
        'INSERT INTO template_exercise (id, template_id, exercise_id, position) VALUES (?, ?, ?, ?)',
        [newId(), id, exerciseId, index],
      );
    }
    await exec.run('COMMIT');
  } catch (error) {
    // 回滚自身也可能抛（连接已断之类）。调用方更需要知道「为什么失败」，
    // 所以回滚的异常吞掉，抛出去的必须是原始异常。
    try {
      await exec.run('ROLLBACK');
    } catch {
      // 忽略：下面抛原始异常
    }
    throw error;
  }

  const detail = await getTemplate(exec, id);
  if (!detail) {
    throw new Error(`计划 ${id} 在写入后查不到了`);
  }
  return detail;
}

/**
 * 删掉一个计划。
 *
 * 两件必须一起做的事：
 * 1. **把引用它的 `session.template_id` 置空。** 这一列刻意没有外键约束
 *    （SQLite 对 `ALTER TABLE` 加的列级外键不强制，见 `schema.ts`），所以
 *    置空这件事只能由这里负责。不置空的话，一场老训练会一直指着一个不存在的
 *    计划 —— 轮转虽然能容错（`nextTemplateIndex` 会回到第一套），但「这场是按
 *    哪套计划练的」就永久错了。
 * 2. **重排剩余计划的 `position`**，不留空洞。
 *
 * 注意这句 `UPDATE` 是安全的：它上面的 `DELETE` 只碰 `split_template` 与
 * `template_exercise`，不碰 `session`，所以不会出现「删 session 的同时又在读
 * session 的子表」那种 `database table is locked`。
 *
 * @param exec SQL 执行器
 * @param id 要删的计划
 * @returns 有多少场历史训练不再指向任何计划（界面可以据此说一句「N 场历史记录
 *   保留着，只是不再属于某个计划」）。**没有历史引用时是 0**
 */
export async function deleteTemplate(
  exec: SqlExecutor,
  id: string,
): Promise<{ affectedSessions: number }> {
  const target = await exec.first<{ position: number }>(
    'SELECT position FROM split_template WHERE id = ?',
    [id],
  );
  if (!target) return { affectedSessions: 0 };

  const affected = await exec.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM session WHERE template_id = ?',
    [id],
  );

  await exec.run('BEGIN');
  try {
    await exec.run('UPDATE session SET template_id = NULL WHERE template_id = ?', [id]);
    await exec.run('DELETE FROM split_template WHERE id = ?', [id]);
    // template_exercise 靠外键级联删掉（建表时就写了 ON DELETE CASCADE）
    await exec.run(
      'UPDATE split_template SET position = position - 1 WHERE position > ?',
      [target.position],
    );
    await exec.run('COMMIT');
  } catch (error) {
    try {
      await exec.run('ROLLBACK');
    } catch {
      // 忽略：下面抛原始异常
    }
    throw error;
  }

  return { affectedSessions: Number(affected?.n ?? 0) };
}

/**
 * 交换两个位置上的计划，用来给列表做上移/下移。
 *
 * 收的是**位置号**而不是计划 id：界面手里就是 `listTemplates` 回来的数组，
 * 上移就是把第 i 项和它前一项换一下，直接给出两个位置号最省事，
 * 也免了「相邻是谁」这种要再查一次库的推理。
 *
 * **必须先把当前那一行挪到一个不冲突的临时位置**（这里是 -1）。直接写两步
 * `UPDATE ... WHERE position = ?` 会两句互相抵消：第一步把当前行写到
 * `targetPosition` 之后，第二步的 `WHERE position = targetPosition` 会同时命中
 * 「刚移动的那一行」和「原本就在那一行的那一个」，于是把两者一起改回原处 ——
 * 顺序纹丝不动，而且**不报任何错**（实测：`node:sqlite` 上三种写法里只有这一种
 * 真能互换）。改写成按 id 定位也不行：第一步之后两行同名，谁都分不出来。
 *
 * `-1` 不会与任何真实 `position` 撞车（`createTemplate` 取的是 `MAX(position) + 1`，
 * 从 0 往上长）。中间那两步之间没有任何读操作，整个互换跑在一个事务里。
 *
 * @param exec SQL 执行器
 * @param currentPosition 要移动的计划当前的位置
 * @param targetPosition 它要去的位置；**与当前相同时直接返回**，不做任何写入
 */
export async function moveTemplate(
  exec: SqlExecutor,
  currentPosition: number,
  targetPosition: number,
): Promise<void> {
  if (currentPosition === targetPosition) return;

  await exec.run('BEGIN');
  try {
    // 1) 当前行让位：挪到临时位置，`currentPosition` 空出来
    await exec.run(
      'UPDATE split_template SET position = ? WHERE position = ?',
      [-1, currentPosition],
    );
    // 2) 原本占着目标位置的那一行补进空出来的位置
    await exec.run(
      'UPDATE split_template SET position = ? WHERE position = ?',
      [currentPosition, targetPosition],
    );
    // 3) 被移动的那一行落到目标位置
    await exec.run(
      'UPDATE split_template SET position = ? WHERE position = ?',
      [targetPosition, -1],
    );
    await exec.run('COMMIT');
  } catch (error) {
    // 回滚自身也可能抛（连接已断之类）。调用方更需要知道「为什么失败」，
    // 所以回滚的异常吞掉，抛出去的必须是原始异常。
    try {
      await exec.run('ROLLBACK');
    } catch {
      // 忽略：下面抛原始异常
    }
    throw error;
  }
}
