import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import { createCustomExercise } from '../repositories/exerciseRepo';
import {
  addExerciseToSession,
  createSession,
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

  it('休息时长正好 30 分钟时不清理（阈值是严格大于）', async () => {
    const { exec, se } = await setupWithRestingSet(30 * MINUTE);

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
