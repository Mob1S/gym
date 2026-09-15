import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import {
  createCustomExercise,
  getExercise,
  listExercises,
  seedExercisesIfEmpty,
} from './exerciseRepo';
import { SEED_EXERCISES } from './seed';

describe('exerciseRepo', () => {
  it('种子数据可以写入，且包含预置动作', async () => {
    const exec = await createMigratedExecutor();
    await seedExercisesIfEmpty(exec);
    const all = await listExercises(exec);
    expect(all.length).toBe(SEED_EXERCISES.length);
    expect(all.map((e) => e.name)).toContain('深蹲');
  });

  it('重复播种不会重复插入', async () => {
    const exec = await createMigratedExecutor();
    await seedExercisesIfEmpty(exec);
    await seedExercisesIfEmpty(exec);
    const all = await listExercises(exec);
    expect(all.length).toBe(SEED_EXERCISES.length);
  });

  it('库中已有自定义动作时也不会重复播种', async () => {
    const exec = await createMigratedExecutor();
    await createCustomExercise(exec, '我的动作', '胸', '哑铃');
    await seedExercisesIfEmpty(exec);
    const all = await listExercises(exec);
    expect(all.length).toBe(1);
  });

  it('isCustom 与 isArchived 正确映射为布尔值', async () => {
    const exec = await createMigratedExecutor();
    const created = await createCustomExercise(exec, '自定义动作', '背', '器械');
    expect(created.isCustom).toBe(true);
    expect(created.isArchived).toBe(false);
  });

  it('getExercise 能取回刚创建的动作', async () => {
    const exec = await createMigratedExecutor();
    const created = await createCustomExercise(exec, '自定义动作', '背', '器械');
    const found = await getExercise(exec, created.id);
    expect(found?.name).toBe('自定义动作');
    expect(found?.muscleGroup).toBe('背');
  });

  it('getExercise 对不存在的 id 返回 null', async () => {
    const exec = await createMigratedExecutor();
    expect(await getExercise(exec, 'nope')).toBeNull();
  });

  it('列表按肌群与名称稳定排序', async () => {
    const exec = await createMigratedExecutor();
    await seedExercisesIfEmpty(exec);
    const all = await listExercises(exec);
    const legs = all.filter((e) => e.muscleGroup === '腿').map((e) => e.name);

    // 必须用 localeCompare('zh') 作参照，也就是拼音序。
    // 这条断言曾经写成 JS 默认的 .sort()（码点序），那是错的：SQLite 的
    // COLLATE NOCASE 对中文只会退化成 UTF-8 码点比较，排出来对人来说是乱序。
    // 排序是产品行为，所以修的是实现，不是这条断言。
    expect(legs).toEqual([...legs].sort((a, b) => a.localeCompare(b, 'zh')));
  });

  it('肌群之间按 胸→背→腿→肩→手臂→核心 的顺序排列', async () => {
    const exec = await createMigratedExecutor();
    await seedExercisesIfEmpty(exec);
    const groups = (await listExercises(exec))
      .map((e) => e.muscleGroup)
      .filter((g, i, arr) => i === 0 || arr[i - 1] !== g);
    expect(groups).toEqual(['胸', '背', '腿', '肩', '手臂', '核心']);
  });
});
