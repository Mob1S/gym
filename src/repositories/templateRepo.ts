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

/** `split_template` 表的原始行 */
interface TemplateRow {
  id: string;
  name: string;
  position: number;
  created_at: number;
}

/** `template_exercise` 表的原始行 */
interface TemplateExerciseRow {
  id: string;
  template_id: string;
  exercise_id: string;
  position: number;
}

/**
 * @param row `split_template` 表的行
 * @returns 领域层的 `SplitTemplate`（snake_case → camelCase）
 */
function toTemplate(row: TemplateRow): SplitTemplate {
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
function toTemplateExercise(row: TemplateExerciseRow): TemplateExercise {
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
