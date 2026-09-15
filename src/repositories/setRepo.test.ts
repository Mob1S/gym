import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import { createCustomExercise } from './exerciseRepo';
import { addExerciseToSession, createSession } from './sessionRepo';
import {
  addSet,
  completeSet,
  endRest,
  getLastPerformance,
  listSets,
  startRest,
} from './setRepo';

async function setup() {
  const exec = await createMigratedExecutor();
  const session = await createSession(exec, '腿部日');
  const exercise = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
  const se = await addExerciseToSession(exec, session.id, exercise.id);
  return { exec, session, exercise, se };
}

describe('setRepo', () => {
  it('新加的组默认未完成，休息字段为空', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);
    expect(set.isCompleted).toBe(false);
    expect(set.restSeconds).toBeNull();
    expect(set.restStartedAt).toBeNull();
    expect(set.completedAt).toBeNull();
  });

  it('组的 position 从 0 开始递增', async () => {
    const { exec, se } = await setup();
    const a = await addSet(exec, se.id, 100, 5);
    const b = await addSet(exec, se.id, 100, 5);
    expect(a.position).toBe(0);
    expect(b.position).toBe(1);
  });

  it('completeSet 写入完成时间', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);
    await completeSet(exec, set.id, 1700000000000);
    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.isCompleted).toBe(true);
    expect(reloaded.completedAt).toBe(1700000000000);
  });

  it('startRest 写入休息开始时间戳', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);
    await startRest(exec, set.id, 1700000000000);
    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.restStartedAt).toBe(1700000000000);
    expect(reloaded.restSeconds).toBeNull();
  });

  it('endRest 用时间戳差算出休息秒数，并清空 restStartedAt', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);
    await startRest(exec, set.id, 1700000000000);
    await endRest(exec, set.id, 1700000083000); // 83 秒后
    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.restSeconds).toBe(83);
    expect(reloaded.restStartedAt).toBeNull();
  });

  it('endRest 在没有 restStartedAt 时不做任何事（不写脏数据）', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);
    await endRest(exec, set.id, 1700000083000);
    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.restSeconds).toBeNull();
  });

  it('listSets 按 position 排序', async () => {
    const { exec, se } = await setup();
    await addSet(exec, se.id, 100, 5);
    await addSet(exec, se.id, 100, 4);
    await addSet(exec, se.id, 100, 3);
    const list = await listSets(exec, se.id);
    expect(list.map((s) => s.reps)).toEqual([5, 4, 3]);
  });

  it('getLastPerformance 返回该动作在更早训练里的完成组', async () => {
    const { exec, exercise } = await setup();

    // 更早的一次训练
    const oldSession = await createSession(exec, '上一次');
    const oldSe = await addExerciseToSession(exec, oldSession.id, exercise.id);
    const oldSet = await addSet(exec, oldSe.id, 95, 5);
    await completeSet(exec, oldSet.id, Date.now());
    await endRest(exec, oldSet.id, Date.now());
    await exec.run('UPDATE session SET finished_at = ? WHERE id = ?', [
      Date.now(),
      oldSession.id,
    ]);

    // 当前训练
    const nowSession = await createSession(exec, '这一次');
    const nowSe = await addExerciseToSession(exec, nowSession.id, exercise.id);

    const last = await getLastPerformance(exec, exercise.id, nowSession.id);
    expect(last.length).toBe(1);
    expect(last[0].weight).toBe(95);
    expect(last[0].reps).toBe(5);
  });

  it('getLastPerformance 在没有历史时返回空数组', async () => {
    const { exec, exercise, session } = await setup();
    const last = await getLastPerformance(exec, exercise.id, session.id);
    expect(last).toEqual([]);
  });

  it('getLastPerformance 只取最近的那一次训练，不混入更早的', async () => {
    const { exec, exercise } = await setup();

    const older = await createSession(exec, '更早');
    const olderSe = await addExerciseToSession(exec, older.id, exercise.id);
    const olderSet = await addSet(exec, olderSe.id, 80, 5);
    await completeSet(exec, olderSet.id, Date.now());
    await exec.run('UPDATE session SET finished_at = ? WHERE id = ?', [
      1000,
      older.id,
    ]);

    const recent = await createSession(exec, '最近');
    const recentSe = await addExerciseToSession(exec, recent.id, exercise.id);
    const recentSet = await addSet(exec, recentSe.id, 95, 5);
    await completeSet(exec, recentSet.id, Date.now());
    await exec.run('UPDATE session SET finished_at = ? WHERE id = ?', [
      2000,
      recent.id,
    ]);

    const now = await createSession(exec, '当前');
    await addExerciseToSession(exec, now.id, exercise.id);

    const last = await getLastPerformance(exec, exercise.id, now.id);
    expect(last.map((s) => s.weight)).toEqual([95]);
  });
});
