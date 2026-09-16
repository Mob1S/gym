import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import type { SqlExecutor } from '../db/types';
import {
  createCustomExercise,
  listExercises,
  seedExercisesIfEmpty,
} from '../repositories/exerciseRepo';
import {
  addExerciseToSession,
  createSession,
  finishSession,
  listSessionExercises,
} from '../repositories/sessionRepo';
import {
  addSet,
  completeSet,
  listSets,
  startRest,
} from '../repositories/setRepo';
import { useActiveSession } from './activeSession';

const MINUTE = 60 * 1000;

/**
 * 造一场训练，其中一个动作里有一组「做完之后一直没按开始下一组」的记录。
 * `restAgeMs` 就是那段休息已经跑了多久。
 */
async function setupWithRestingSet(restAgeMs: number) {
  const exec = await createMigratedExecutor();
  const session = await createSession(exec, '腿部日');
  const exercise = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
  const se = await addExerciseToSession(exec, session.id, exercise.id);
  const set = await addSet(exec, se.id, 100, 5);

  await completeSet(exec, set.id, Date.now());
  await startRest(exec, set.id, Date.now() - restAgeMs);

  return { exec, session, se, setId: set.id };
}

/**
 * 造一场**已结束**的训练（也就是「上一次训练」），动作按传入的名字依次加入。
 * 返回的 `exerciseIds` 与传入顺序一一对应，用来验证复制过来的顺序。
 */
async function setupFinishedSession(
  exec: SqlExecutor,
  names: string[],
): Promise<{ exerciseIds: string[] }> {
  const session = await createSession(exec, '上一次训练');
  const exerciseIds: string[] = [];
  for (const name of names) {
    const exercise = await createCustomExercise(exec, name, '胸', '杠铃');
    await addExerciseToSession(exec, session.id, exercise.id);
    exerciseIds.push(exercise.id);
  }
  await finishSession(exec, session.id, Date.now());
  return { exerciseIds };
}

describe('恢复训练时对休息状态的收拾', () => {
  beforeEach(() => {
    useActiveSession.getState().reset();
  });

  it('休息跑过头（31 分钟）时自动清掉，且不写入 rest_seconds', async () => {
    const { exec, se } = await setupWithRestingSet(31 * MINUTE);

    await useActiveSession.getState().resume(exec);

    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.restStartedAt).toBeNull();
    // 关键：那段荒唐的时长不能被当成真实休息留下来，
    // 否则休息建议的平均值会被一条 31 分钟的记录带偏。
    expect(reloaded.restSeconds).toBeNull();
  });

  it('刚跑起来的休息（1 分钟）原样保留，不被误伤', async () => {
    const { exec, se } = await setupWithRestingSet(1 * MINUTE);

    await useActiveSession.getState().resume(exec);

    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.restStartedAt).not.toBeNull();
  });

  it('休息贴着 30 分钟阈值（29 分 59 秒）时不清理', async () => {
    // 这里刻意比阈值少 1 秒，而不是正好卡在 30 分钟上。
    // `startRest` 用的是测试里的 `Date.now()`，`resume` 里的判定用的是稍后
    // 另一个 `Date.now()` —— 两者之间任何 1 毫秒的调度/GC 抖动都会让
    // 「正好 30 分钟」变成「超过 30 分钟」，断言随机变红（实测：去掉这个
    // 改动、在原始代码上连跑 6 次全量，第 5 次红的就是这一条）。
    // 「严格大于」这个边界本身已经由 `src/domain/rest.test.ts` 用固定时间戳
    // 确定性地覆盖了；这里要守住的是「一段很长但真实的长休息能完整走完
    // resume 而不被误伤」。
    const { exec, se } = await setupWithRestingSet(30 * MINUTE - 1000);

    await useActiveSession.getState().resume(exec);

    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.restStartedAt).not.toBeNull();
  });

  it('清理之后界面拿到的是记录态，而不是被堵在休息页', async () => {
    const { exec } = await setupWithRestingSet(45 * MINUTE);

    await useActiveSession.getState().resume(exec);

    const { exercises } = useActiveSession.getState();
    const resting = exercises
      .flatMap((e) => e.sets)
      .find((s) => s.isCompleted && s.restStartedAt !== null);
    expect(resting).toBeUndefined();
  });

  it('跑过头的休息被清掉后，已完成的组本身不受影响', async () => {
    const { exec, se } = await setupWithRestingSet(45 * MINUTE);

    await useActiveSession.getState().resume(exec);

    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.isCompleted).toBe(true);
    expect(reloaded.weight).toBe(100);
    expect(reloaded.reps).toBe(5);
  });
});

describe('开始新训练时沿用上一次的动作组合', () => {
  beforeEach(() => {
    useActiveSession.getState().reset();
  });

  it('全新库（没有任何已结束的训练）里开训练不带任何动作', async () => {
    const exec = await createMigratedExecutor();
    // 预置动作库必须灌进来，否则这条测试是假绿的：`createMigratedExecutor`
    // 只跑迁移，迁移不插动作（灌库在 `seedExercisesIfEmpty` 里），空库下
    // 旧实现找不到「深蹲」，也会得到空数组 —— 那样就测不出用户报的那个
    // 「每次训练都以深蹲开头」了。
    await seedExercisesIfEmpty(exec);
    expect((await listExercises(exec)).some((e) => e.name === '深蹲')).toBe(true);

    await useActiveSession.getState().startNew(exec, null);

    const { session, exercises } = useActiveSession.getState();
    expect(session).not.toBeNull();
    expect(exercises).toEqual([]);
    // 不只是内存里没加载出来：库里也确实一条 session_exercise 都没有。
    expect(await listSessionExercises(exec, session!.id)).toEqual([]);
  });

  it('有上一次已结束的训练时，按原来的顺序复制它的动作', async () => {
    const exec = await createMigratedExecutor();
    const { exerciseIds } = await setupFinishedSession(exec, ['深蹲', '卧推']);

    await useActiveSession.getState().startNew(exec, null);

    const { exercises } = useActiveSession.getState();
    expect(exercises.map((e) => e.exerciseName)).toEqual(['深蹲', '卧推']);
    expect(exercises.map((e) => e.sessionExercise.exerciseId)).toEqual(
      exerciseIds,
    );
  });

  it('复制过来的每个动作都预建了一个待完成的组', async () => {
    const exec = await createMigratedExecutor();
    await setupFinishedSession(exec, ['深蹲', '卧推']);

    await useActiveSession.getState().startNew(exec, null);

    const { exercises } = useActiveSession.getState();
    expect(exercises).toHaveLength(2);
    for (const item of exercises) {
      // 没有这条待完成的组，记录界面找不到该记哪一组，
      // `completeCurrentSet` 会直接 return —— 用户点「完成这组」毫无反应。
      expect(item.sets.length).toBeGreaterThanOrEqual(1);
      expect(item.sets.every((s) => s.isCompleted === false)).toBe(true);
    }
  });

  it('还在进行中的训练不算「上一次」，不会被复制', async () => {
    const exec = await createMigratedExecutor();
    // 同上：预置库也灌上，这条才同时挡住「从进行中的训练复制」和
    // 「随便挑一个动作塞进去」两种旧行为。
    await seedExercisesIfEmpty(exec);
    const running = await createSession(exec, '没结束的训练');
    const exercise = await createCustomExercise(exec, '硬拉', '背', '杠铃');
    await addExerciseToSession(exec, running.id, exercise.id);

    await useActiveSession.getState().startNew(exec, null);

    const { exercises } = useActiveSession.getState();
    expect(exercises).toEqual([]);
  });
});
