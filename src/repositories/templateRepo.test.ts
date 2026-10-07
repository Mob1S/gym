import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import type { SqlExecutor } from '../db/types';
import { createCustomExercise } from './exerciseRepo';
import {
  createTemplate,
  getTemplate,
  listTemplates,
  renameTemplate,
  setTemplateExercises,
} from './templateRepo';

/** 造几个动作，返回它们的 id（顺序与传入的名字一一对应） */
async function makeExercises(
  exec: SqlExecutor,
  names: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const exercise = await createCustomExercise(exec, name, '胸', '杠铃');
    ids.push(exercise.id);
  }
  return ids;
}

describe('templateRepo', () => {
  it('空库时没有任何计划', async () => {
    const exec = await createMigratedExecutor();
    expect(await listTemplates(exec)).toEqual([]);
  });

  it('按 position 升序返回计划，并带上动作数', async () => {
    const exec = await createMigratedExecutor();
    const [squat, bench] = await makeExercises(exec, ['深蹲', '卧推']);
    const push = await createTemplate(exec, '推日');
    const legs = await createTemplate(exec, '腿日');
    await setTemplateExercises(exec, push.id, [bench]);
    await setTemplateExercises(exec, legs.id, [squat, bench]);

    const templates = await listTemplates(exec);

    expect(templates.map((t) => t.name)).toEqual(['推日', '腿日']);
    // 动作数必须在这一次查询里就带回来。设置页要列全部计划，
    // 每个计划再查一次动作数就是 N+1 —— 手机上肉眼可见地卡。
    expect(templates.map((t) => t.exerciseCount)).toEqual([1, 2]);
  });

  it('getTemplate 按 position 返回动作，并带上动作名', async () => {
    const exec = await createMigratedExecutor();
    const [squat, bench] = await makeExercises(exec, ['深蹲', '卧推']);
    const legs = await createTemplate(exec, '腿日');
    await setTemplateExercises(exec, legs.id, [squat, bench]);

    const detail = await getTemplate(exec, legs.id);

    expect(detail?.template.name).toBe('腿日');
    expect(detail?.exercises.map((e) => e.exerciseName)).toEqual(['深蹲', '卧推']);
    expect(detail?.exercises.map((e) => e.templateExercise.position)).toEqual([0, 1]);
  });

  it('getTemplate 对不存在的 id 返回 null', async () => {
    const exec = await createMigratedExecutor();
    expect(await getTemplate(exec, 'nope')).toBeNull();
  });

  it('setTemplateExercises 是整体覆盖：删掉的没了、加上的在、顺序按传入的来', async () => {
    const exec = await createMigratedExecutor();
    const [squat, bench, fly] = await makeExercises(exec, ['深蹲', '卧推', '飞鸟']);
    const push = await createTemplate(exec, '推日');

    await setTemplateExercises(exec, push.id, [bench, squat]);
    const detail = await setTemplateExercises(exec, push.id, [fly, bench]);

    expect(detail.exercises.map((e) => e.exerciseName)).toEqual(['飞鸟', '卧推']);
    expect(detail.exercises.map((e) => e.templateExercise.position)).toEqual([0, 1]);
    // 深蹲被覆盖掉了：不是软删，是真的不在这个计划里
    expect(detail.exercises.some((e) => e.exerciseName === '深蹲')).toBe(false);
  });

  it('同一个动作可以在计划里出现两次（有人真的这么练）', async () => {
    const exec = await createMigratedExecutor();
    const [squat] = await makeExercises(exec, ['深蹲']);
    const legs = await createTemplate(exec, '腿日');

    const detail = await setTemplateExercises(exec, legs.id, [squat, squat]);

    expect(detail.exercises).toHaveLength(2);
    // 两条 template_exercise 必须是不同的 id，否则删一条会连带删掉两条
    expect(detail.exercises[0].templateExercise.id).not.toBe(
      detail.exercises[1].templateExercise.id,
    );
  });

  it('renameTemplate 只改名字，动作不受影响', async () => {
    const exec = await createMigratedExecutor();
    const [squat] = await makeExercises(exec, ['深蹲']);
    const legs = await createTemplate(exec, '腿日');
    await setTemplateExercises(exec, legs.id, [squat]);

    await renameTemplate(exec, legs.id, '腿部日');

    const detail = await getTemplate(exec, legs.id);
    expect(detail?.template.name).toBe('腿部日');
    expect(detail?.exercises).toHaveLength(1);
  });
});
