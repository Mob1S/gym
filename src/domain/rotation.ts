/**
 * 「今天该练哪一套」。
 *
 * 这是分化循环的全部逻辑，刻意做成纯函数：它要处理的全是边界（只有一套、
 * 绕回第一套、上一场没按计划练、计划已被删），这些边界在纯函数里几行就能
 * 全部锁住，塞进 store 或 SQL 里就只能靠真机试。
 *
 * **轮转指针不单独存**，它是从「最近一场已结束训练用的模板」推出来的（见
 * `WorkoutSession.templateId`）。多存一个「下一个该练第几套」的字段，就要在
 * 跳过、删计划、导入记录、恢复备份四条路径上同步维护它，一旦不符表现是
 * 「轮转莫名跳了一套」——用户看得见，又最难解释。
 */

/**
 * @param templates 全部计划，**顺序必须是轮转顺序**（即按 `position` 升序），
 *   函数按数组下标往后数，不读 `position` 字段
 * @param lastTemplateId 最近一场已结束训练用的计划 id；null = 没有这样的训练
 *   （第一次用、或者之前都是不按计划练的）
 * @returns 这一场该用的计划在 `templates` 里的下标；**没有任何计划时返回 null**，
 *   调用方据此退回旧行为（复制最近一场的动作）
 */
export function nextTemplateIndex(
  templates: { id: string }[],
  lastTemplateId: string | null,
): number | null {
  if (templates.length === 0) return null;

  // `findIndex` 找不到时是 -1，`-1 + 1` 正好是 0（回到第一套），
  // 于是「上一场没按计划练」和「上一场的计划已被删除」两件事不用分开处理。
  const lastIndex = templates.findIndex((t) => t.id === lastTemplateId);
  return (lastIndex + 1) % templates.length;
}
