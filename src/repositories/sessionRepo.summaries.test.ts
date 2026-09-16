import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import { createCustomExercise } from './exerciseRepo';
import {
  addExerciseToSession,
  createSession,
  finishSession,
  listSessionSummaries,
} from './sessionRepo';
import { addSet, completeSet } from './setRepo';

const MINUTE = 60 * 1000;

/** 造一场已结束的训练，含若干已完成组 */
async function makeFinishedSession(
  exec: Awaited<ReturnType<typeof createMigratedExecutor>>,
  label: string,
  startedAt: number,
  finishedAt: number,
  sets: { weight: number; reps: number; completed: boolean }[],
) {
  const session = await createSession(exec, label);
  // createSession 用 Date.now() 写 started_at，这里覆写成测试指定值
  await exec.run('UPDATE session SET started_at = ? WHERE id = ?', [
    startedAt,
    session.id,
  ]);

  const exercise = await createCustomExercise(exec, `动作-${label}`, '腿', '杠铃');
  const se = await addExerciseToSession(exec, session.id, exercise.id);
  for (const s of sets) {
    const set = await addSet(exec, se.id, s.weight, s.reps);
    if (s.completed) await completeSet(exec, set.id, startedAt);
  }
  await finishSession(exec, session.id, finishedAt);
  return session.id;
}

describe('listSessionSummaries', () => {
  it('没有历史时返回空数组', async () => {
    const exec = await createMigratedExecutor();
    expect(await listSessionSummaries(exec, 10)).toEqual([]);
  });

  it('进行中的训练不出现在历史里', async () => {
    const exec = await createMigratedExecutor();
    await createSession(exec, '还没练完');
    expect(await listSessionSummaries(exec, 10)).toEqual([]);
  });

  it('返回时长、组数与容量', async () => {
    const exec = await createMigratedExecutor();
    const t0 = 1_700_000_000_000;
    await makeFinishedSession(exec, '腿部日', t0, t0 + 52 * MINUTE, [
      { weight: 100, reps: 5, completed: true },
      { weight: 100, reps: 5, completed: true },
      { weight: 100, reps: 3, completed: true },
    ]);

    const [row] = await listSessionSummaries(exec, 10);
    expect(row.name).toBe('腿部日');
    expect(row.durationMinutes).toBe(52);
    expect(row.setCount).toBe(3);
    expect(row.volumeKg).toBe(1300);
  });

  it('未完成的组不计入组数与容量', async () => {
    const exec = await createMigratedExecutor();
    const t0 = 1_700_000_000_000;
    await makeFinishedSession(exec, '腿部日', t0, t0 + 10 * MINUTE, [
      { weight: 100, reps: 5, completed: true },
      { weight: 100, reps: 5, completed: false },
    ]);

    const [row] = await listSessionSummaries(exec, 10);
    expect(row.setCount).toBe(1);
    expect(row.volumeKg).toBe(500);
  });

  it('一个动作都没有的训练返回 0 组 0 容量，而不是被漏掉', async () => {
    const exec = await createMigratedExecutor();
    const session = await createSession(exec, '空训练');
    await finishSession(exec, session.id, Date.now());

    const rows = await listSessionSummaries(exec, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].setCount).toBe(0);
    expect(rows[0].volumeKg).toBe(0);
  });

  it('按开始时间倒序，最新的在最前', async () => {
    const exec = await createMigratedExecutor();
    const t0 = 1_700_000_000_000;
    await makeFinishedSession(exec, '早的', t0, t0 + MINUTE, []);
    await makeFinishedSession(exec, '晚的', t0 + 60 * MINUTE, t0 + 61 * MINUTE, []);

    const rows = await listSessionSummaries(exec, 10);
    expect(rows.map((r) => r.name)).toEqual(['晚的', '早的']);
  });

  it('同毫秒开始的两次训练顺序仍然确定（rowid 兜底）', async () => {
    const exec = await createMigratedExecutor();
    const t0 = 1_700_000_000_000;
    await makeFinishedSession(exec, '先建', t0, t0 + MINUTE, []);
    await makeFinishedSession(exec, '后建', t0, t0 + MINUTE, []);

    const rows = await listSessionSummaries(exec, 10);
    expect(rows.map((r) => r.name)).toEqual(['后建', '先建']);
  });

  it('尊重 limit', async () => {
    const exec = await createMigratedExecutor();
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 4; i++) {
      await makeFinishedSession(exec, `第${i}场`, t0 + i * MINUTE, t0 + (i + 1) * MINUTE, []);
    }
    expect(await listSessionSummaries(exec, 2)).toHaveLength(2);
  });

  it('多个动作的容量会累加，不会因为 JOIN 翻倍', async () => {
    const exec = await createMigratedExecutor();
    const t0 = 1_700_000_000_000;
    const session = await createSession(exec, '两个动作');
    await exec.run('UPDATE session SET started_at = ? WHERE id = ?', [t0, session.id]);

    for (const name of ['深蹲', '腿举']) {
      const ex = await createCustomExercise(exec, name, '腿', '杠铃');
      const se = await addExerciseToSession(exec, session.id, ex.id);
      const set = await addSet(exec, se.id, 100, 5);
      await completeSet(exec, set.id, t0);
    }
    await finishSession(exec, session.id, t0 + MINUTE);

    const [row] = await listSessionSummaries(exec, 10);
    expect(row.setCount).toBe(2);
    expect(row.volumeKg).toBe(1000);
  });
});
