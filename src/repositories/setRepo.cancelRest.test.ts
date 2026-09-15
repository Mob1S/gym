import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import { createCustomExercise } from './exerciseRepo';
import { addExerciseToSession, createSession } from './sessionRepo';
import {
  addSet,
  cancelRest,
  endRest,
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

describe('cancelRest', () => {
  it('清掉 rest_started_at', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);
    await startRest(exec, set.id, 1_700_000_000_000);

    await cancelRest(exec, set.id);

    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.restStartedAt).toBeNull();
  });

  it('不写入 rest_seconds —— 这正是它和 endRest 的区别', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);
    await startRest(exec, set.id, 1_700_000_000_000);

    await cancelRest(exec, set.id);

    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.restSeconds).toBeNull();
  });

  it('对照：endRest 会计入秒数，cancelRest 不记', async () => {
    const { exec, se } = await setup();
    const counted = await addSet(exec, se.id, 100, 5);
    const dropped = await addSet(exec, se.id, 100, 5);

    await startRest(exec, counted.id, 1_700_000_000_000);
    await endRest(exec, counted.id, 1_700_000_000_000 + 83_000);

    await startRest(exec, dropped.id, 1_700_000_000_000);
    await cancelRest(exec, dropped.id);

    const sets = await listSets(exec, se.id);
    expect(sets[0].restSeconds).toBe(83);
    expect(sets[1].restSeconds).toBeNull();
  });

  it('只影响指定的那一组', async () => {
    const { exec, se } = await setup();
    const a = await addSet(exec, se.id, 100, 5);
    const b = await addSet(exec, se.id, 100, 5);
    await startRest(exec, a.id, 1_700_000_000_000);
    await startRest(exec, b.id, 1_700_000_000_000);

    await cancelRest(exec, a.id);

    const sets = await listSets(exec, se.id);
    expect(sets[0].restStartedAt).toBeNull();
    expect(sets[1].restStartedAt).toBe(1_700_000_000_000);
  });

  it('对本来就没在休息的组调用是安全的空操作', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);

    await cancelRest(exec, set.id);

    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.restStartedAt).toBeNull();
    expect(reloaded.restSeconds).toBeNull();
  });
});
