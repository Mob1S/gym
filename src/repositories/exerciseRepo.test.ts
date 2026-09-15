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
    // 参照比较器用的是 JS 默认的 code-unit 排序，而不是 localeCompare('zh')：
    // SQLite 的 COLLATE NOCASE 只做 ASCII 大小写折叠，对中文一律退化为按 UTF-8
    // 码点比较；JS 的 localeCompare('zh') 走 ICU 拼音排序。两者对「保加利亚分腿蹲 /
    // 前蹲 / 坐姿提踵 / 深蹲 / …」给出不同顺序，SQLite 侧除非注册自定义 collation
    // 否则无法复现拼音序。实现里的 ORDER BY 保证的正是「稳定、确定」的码点序。
    expect(legs).toEqual([...legs].sort());
  });
});
