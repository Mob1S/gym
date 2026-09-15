import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import { createCustomExercise } from './exerciseRepo';
import { addExerciseToSession, createSession } from './sessionRepo';
import { addSet, listSets, updateSetValues } from './setRepo';

async function setup() {
  const exec = await createMigratedExecutor();
  const session = await createSession(exec, '腿部日');
  const exercise = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
  const se = await addExerciseToSession(exec, session.id, exercise.id);
  return { exec, session, exercise, se };
}

/**
 * `updateSetValues` 是 Task 7 从 store 里提出来的：记录界面要先把用户填的
 * 重量/次数写进那一组，再标记完成，而 store 不许自己写 SQL。
 */
describe('updateSetValues', () => {
  it('改写重量与次数', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 20, 8);

    await updateSetValues(exec, set.id, 102.5, 5);

    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.weight).toBe(102.5);
    expect(reloaded.reps).toBe(5);
  });

  it('不改动完成状态与休息字段', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);

    await updateSetValues(exec, set.id, 100, 4);

    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.isCompleted).toBe(false);
    expect(reloaded.restSeconds).toBeNull();
    expect(reloaded.restStartedAt).toBeNull();
    expect(reloaded.completedAt).toBeNull();
  });

  it('只影响指定的那一组', async () => {
    const { exec, se } = await setup();
    const a = await addSet(exec, se.id, 100, 5);
    await addSet(exec, se.id, 100, 5);

    await updateSetValues(exec, a.id, 60, 12);

    const list = await listSets(exec, se.id);
    expect(list.map((s) => [s.weight, s.reps])).toEqual([
      [60, 12],
      [100, 5],
    ]);
  });
});
