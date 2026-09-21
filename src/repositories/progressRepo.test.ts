import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import type { SqlExecutor } from '../db/types';
import { createCustomExercise } from './exerciseRepo';
import {
  listCompletedSetPoints,
  listTrainedExercises,
} from './progressRepo';
import {
  addExerciseToSession,
  createSession,
  finishSession,
} from './sessionRepo';
import { addSet, completeSet } from './setRepo';

/** 在一场训练里给某个动作记一组已完成的数据 */
async function record(
  exec: SqlExecutor,
  sessionId: string,
  exerciseId: string,
  weight: number,
  reps: number,
  completedAt: number,
): Promise<void> {
  const se = await addExerciseToSession(exec, sessionId, exerciseId);
  const set = await addSet(exec, se.id, weight, reps);
  await completeSet(exec, set.id, completedAt);
}

describe('progressRepo', () => {
  it('取回已完成组的原始点，按训练时间升序', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');

    const later = await createSession(exec, '后一场');
    await exec.run('UPDATE session SET started_at = ? WHERE id = ?', [
      2_000,
      later.id,
    ]);
    await record(exec, later.id, squat.id, 60, 8, 2_100);
    await finishSession(exec, later.id, 2_200);

    const earlier = await createSession(exec, '前一场');
    await exec.run('UPDATE session SET started_at = ? WHERE id = ?', [
      1_000,
      earlier.id,
    ]);
    await record(exec, earlier.id, squat.id, 55, 10, 1_100);
    await finishSession(exec, earlier.id, 1_200);

    const points = await listCompletedSetPoints(exec, squat.id);

    expect(points.map((p) => p.startedAt)).toEqual([1_000, 2_000]);
    expect(points[0]).toEqual({
      exerciseId: squat.id,
      sessionId: earlier.id,
      startedAt: 1_000,
      weight: 55,
      reps: 10,
    });
  });

  it('没完成的那一组不算 —— 它是记录界面预建的占位', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const session = await createSession(exec, '一场');
    const se = await addExerciseToSession(exec, session.id, squat.id);
    await addSet(exec, se.id, 100, 5); // 建出来但没完成
    const done = await addSet(exec, se.id, 100, 5);
    await completeSet(exec, done.id, 1_000);
    await finishSession(exec, session.id, 2_000);

    expect(await listCompletedSetPoints(exec, squat.id)).toHaveLength(1);
  });

  it('进行中的训练整场不算', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const running = await createSession(exec, '还没结束');
    await record(exec, running.id, squat.id, 100, 5, 1_000);
    // 故意不调 finishSession

    expect(await listCompletedSetPoints(exec, squat.id)).toEqual([]);
  });

  it('只要这个动作的组，同一场里别的动作不算', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const bench = await createCustomExercise(exec, '卧推', '胸', '杠铃');
    const session = await createSession(exec, '一场');
    await record(exec, session.id, squat.id, 100, 5, 1_000);
    await record(exec, session.id, bench.id, 60, 8, 1_100);
    await finishSession(exec, session.id, 2_000);

    const points = await listCompletedSetPoints(exec, squat.id);
    expect(points).toHaveLength(1);
    expect(points[0].weight).toBe(100);
  });

  it('不传 exerciseId 时返回所有动作的点', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const bench = await createCustomExercise(exec, '卧推', '胸', '杠铃');
    const session = await createSession(exec, '一场');
    await record(exec, session.id, squat.id, 100, 5, 1_000);
    await record(exec, session.id, bench.id, 60, 8, 1_100);
    await finishSession(exec, session.id, 2_000);

    const points = await listCompletedSetPoints(exec);
    expect(points.map((p) => p.exerciseId).sort()).toEqual(
      [squat.id, bench.id].sort(),
    );
  });

  it('listTrainedExercises 按最近练过倒序，没练过的不出现', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const bench = await createCustomExercise(exec, '卧推', '胸', '杠铃');
    await createCustomExercise(exec, '从没练过的动作', '背', '杠铃');

    const first = await createSession(exec, '第一场');
    await exec.run('UPDATE session SET started_at = ? WHERE id = ?', [
      1_000,
      first.id,
    ]);
    await record(exec, first.id, squat.id, 100, 5, 1_100);
    await finishSession(exec, first.id, 1_200);

    const second = await createSession(exec, '第二场');
    await exec.run('UPDATE session SET started_at = ? WHERE id = ?', [
      3_000,
      second.id,
    ]);
    await record(exec, second.id, bench.id, 60, 8, 3_100);
    await finishSession(exec, second.id, 3_200);

    const trained = await listTrainedExercises(exec);

    expect(trained.map((t) => t.name)).toEqual(['卧推', '深蹲']);
    expect(trained[0]).toEqual({
      exerciseId: bench.id,
      name: '卧推',
      lastTrainedAt: 3_000,
    });
  });

  it('没有任何训练时两个查询都返回空数组', async () => {
    const exec = await createMigratedExecutor();
    expect(await listCompletedSetPoints(exec)).toEqual([]);
    expect(await listTrainedExercises(exec)).toEqual([]);
  });
});
