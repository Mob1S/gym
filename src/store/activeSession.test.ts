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
  getSession,
  listSessionExercises,
} from '../repositories/sessionRepo';
import {
  addSet,
  completeSet,
  listSets,
  startRest,
} from '../repositories/setRepo';
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  setTemplateExercises,
} from '../repositories/templateRepo';
import { useActiveSession } from './activeSession';

const MINUTE = 60 * 1000;

/**
 * 造一场训练，其中一个动作里有一组「做完之后一直没按开始下一组」的记录。
 * `restAgeMs` 就是那段休息已经跑了多久。
 */
async function setupWithRestingSet(restAgeMs: number) {
  const exec = await createMigratedExecutor();
  const session = await createSession(exec, '腿部日', null);
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
  const session = await createSession(exec, '上一次训练', null);
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

  it('进行中的训练不会被当成「上一次」，startNew 直接交回冲突', async () => {
    const exec = await createMigratedExecutor();
    // 同上：预置库也灌上，这条才同时挡住「从进行中的训练复制」和
    // 「随便挑一个动作塞进去」两种旧行为。
    await seedExercisesIfEmpty(exec);
    const running = await createSession(exec, '没结束的训练', null);
    const exercise = await createCustomExercise(exec, '硬拉', '背', '杠铃');
    await addExerciseToSession(exec, running.id, exercise.id);

    expect(await useActiveSession.getState().startNew(exec, null)).toBe('conflict');
    // 没有新建任何训练，也就没有「复制了谁」这回事
    expect(useActiveSession.getState().session?.id).toBe(running.id);
  });
});

/** 库里还剩几条没结束的训练 —— 不变量就是它 ≤ 1 */
async function countUnfinished(exec: SqlExecutor): Promise<number> {
  const row = await exec.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM session WHERE finished_at IS NULL',
  );
  return Number(row?.n ?? 0);
}

async function countAllSessions(exec: SqlExecutor): Promise<number> {
  const row = await exec.first<{ n: number }>('SELECT COUNT(*) AS n FROM session');
  return Number(row?.n ?? 0);
}

describe('进行中的训练最多一条', () => {
  beforeEach(() => {
    useActiveSession.getState().reset();
  });

  it('结束训练之后 store 立刻清空，库里也写上了 finished_at', async () => {
    const exec = await createMigratedExecutor();

    await useActiveSession.getState().startNew(exec, null);
    const id = useActiveSession.getState().session!.id;
    const finishedId = await useActiveSession.getState().endWorkout(exec);

    expect(finishedId).toBe(id);
    // 这一条就是用户报的 bug：结束之后主页还显示「继续上次训练」，
    // 因为内存里那条没清。
    expect(useActiveSession.getState().session).toBeNull();
    expect(await countUnfinished(exec)).toBe(0);
  });

  it('结束之后紧接着开新的一场，不会再撞上冲突', async () => {
    const exec = await createMigratedExecutor();

    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().endWorkout(exec);

    expect(await useActiveSession.getState().startNew(exec, null)).toBe('started');
    expect(await countUnfinished(exec)).toBe(1);
  });

  it('库里有一场进行中的训练时，startNew 返回 conflict 且不新建', async () => {
    const exec = await createMigratedExecutor();
    const running = await createSession(exec, '没结束的训练', null);

    expect(await useActiveSession.getState().startNew(exec, null)).toBe('conflict');
    expect(await countAllSessions(exec)).toBe(1);
    // 冲突的那一场必须已经装进 store：界面选「接着练」要直接导航过去，
    // 选「结束它」要能对它调 endWorkout。
    expect(useActiveSession.getState().session?.id).toBe(running.id);
  });

  it('连着调两次 startNew，只会留下一条未结束的训练', async () => {
    const exec = await createMigratedExecutor();

    expect(await useActiveSession.getState().startNew(exec, null)).toBe('started');
    expect(await useActiveSession.getState().startNew(exec, null)).toBe('conflict');

    expect(await countUnfinished(exec)).toBe(1);
  });

  it('已结束的训练不会被 resume 接回来', async () => {
    const exec = await createMigratedExecutor();

    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().endWorkout(exec);

    expect(await useActiveSession.getState().resume(exec)).toBe(false);
    expect(useActiveSession.getState().session).toBeNull();
  });

  it('已结束的训练不接受新动作（防御闸门）', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');

    await useActiveSession.getState().startNew(exec, null);
    const id = useActiveSession.getState().session!.id;
    await useActiveSession.getState().endWorkout(exec);

    // 模拟「有人绕过状态机，把一场已结束的训练塞回 store」
    const finished = await getSession(exec, id);
    useActiveSession.setState({ session: finished });
    await useActiveSession.getState().addExercise(exec, squat.id);

    expect(await listSessionExercises(exec, id)).toEqual([]);
  });
});

describe('resume 恢复练到第几个动作', () => {
  beforeEach(() => {
    useActiveSession.getState().reset();
  });

  it('停在上次最后碰过的那个动作，而不是永远回到第一个', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const bench = await createCustomExercise(exec, '卧推', '胸', '杠铃');

    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().addExercise(exec, squat.id);
    await useActiveSession.getState().completeCurrentSet(exec, 100, 5);
    await useActiveSession.getState().completeCurrentSet(exec, 100, 5);
    await useActiveSession.getState().addExercise(exec, bench.id);
    await useActiveSession.getState().completeCurrentSet(exec, 60, 8);

    useActiveSession.getState().reset(); // 等价于 App 被杀之后重启
    expect(await useActiveSession.getState().resume(exec)).toBe(true);

    const { exercises, currentIndex } = useActiveSession.getState();
    expect(exercises.map((e) => e.exerciseName)).toEqual(['深蹲', '卧推']);
    // 用户是在练卧推的时候被杀的，回来就该在卧推上
    expect(exercises[currentIndex].exerciseName).toBe('卧推');
  });

  it('一组都没做时回到第一个动作', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');

    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().addExercise(exec, squat.id);

    useActiveSession.getState().reset();
    await useActiveSession.getState().resume(exec);

    expect(useActiveSession.getState().currentIndex).toBe(0);
  });
});

/**
 * 造一套计划并把它填满动作。返回计划 id。
 * `names` 决定动作清单，顺序即计划里的顺序。
 */
async function setupTemplate(
  exec: SqlExecutor,
  templateName: string,
  exerciseNames: string[],
): Promise<string> {
  const template = await createTemplate(exec, templateName);
  const ids: string[] = [];
  for (const name of exerciseNames) {
    const exercise = await createCustomExercise(exec, name, '胸', '杠铃');
    ids.push(exercise.id);
  }
  await setTemplateExercises(exec, template.id, ids);
  return template.id;
}

describe('开始新训练时按分化循环取计划', () => {
  beforeEach(() => {
    useActiveSession.getState().reset();
  });

  it('一套计划、一场都没练过时，用第一套', async () => {
    const exec = await createMigratedExecutor();
    await setupTemplate(exec, '推日', ['卧推', '飞鸟']);

    await useActiveSession.getState().startNew(exec, null);

    const { session, exercises } = useActiveSession.getState();
    expect(exercises.map((e) => e.exerciseName)).toEqual(['卧推', '飞鸟']);
    // 这一场要记住自己是按哪套计划练的，否则下一场推不出该轮到谁
    expect(session?.templateId).not.toBeNull();
  });

  it('练完两场之后轮到第三套，第四场绕回第一套', async () => {
    const exec = await createMigratedExecutor();
    const push = await setupTemplate(exec, '推日', ['卧推']);
    const pull = await setupTemplate(exec, '拉日', ['划船']);
    const legs = await setupTemplate(exec, '腿日', ['深蹲']);

    await useActiveSession.getState().startNew(exec, null);
    expect(useActiveSession.getState().session?.templateId).toBe(push);
    await useActiveSession.getState().endWorkout(exec);

    await useActiveSession.getState().startNew(exec, null);
    expect(useActiveSession.getState().session?.templateId).toBe(pull);
    await useActiveSession.getState().endWorkout(exec);

    await useActiveSession.getState().startNew(exec, null);
    expect(useActiveSession.getState().session?.templateId).toBe(legs);
    expect(useActiveSession.getState().exercises.map((e) => e.exerciseName)).toEqual([
      '深蹲',
    ]);
    await useActiveSession.getState().endWorkout(exec);

    // 循环：第四场回到推日，而不是没有计划可用
    await useActiveSession.getState().startNew(exec, null);
    expect(useActiveSession.getState().session?.templateId).toBe(push);
  });

  it('一套计划都没有时，维持旧行为：复制上一次已结束训练的动作', async () => {
    const exec = await createMigratedExecutor();
    await setupFinishedSession(exec, ['深蹲', '卧推']);

    await useActiveSession.getState().startNew(exec, null);

    const { session, exercises } = useActiveSession.getState();
    expect(exercises.map((e) => e.exerciseName)).toEqual(['深蹲', '卧推']);
    // 没按任何计划练，所以是 null —— 这样它不会参与轮转
    expect(session?.templateId).toBeNull();
  });

  it('startNewWithTemplate 直接用指定的计划，不管轮转轮到谁', async () => {
    const exec = await createMigratedExecutor();
    const push = await setupTemplate(exec, '推日', ['卧推']);
    await setupTemplate(exec, '拉日', ['划船']);

    // 轮转本该给出「推日」，用户主动改选「拉日」
    const pull = (await listTemplates(exec))[1].id;
    await useActiveSession.getState().startNewWithTemplate(exec, null, pull);

    expect(useActiveSession.getState().session?.templateId).toBe(pull);
    expect(useActiveSession.getState().exercises.map((e) => e.exerciseName)).toEqual([
      '划船',
    ]);
    // 推日那套没被动过
    expect(push).not.toBe(pull);
  });

  it('计划被删掉之后，轮转回到第一套而不是卡住', async () => {
    const exec = await createMigratedExecutor();
    const push = await setupTemplate(exec, '推日', ['卧推']);
    const pull = await setupTemplate(exec, '拉日', ['划船']);

    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().endWorkout(exec);
    // 第二场用的是 pull，现在把 pull 删掉
    await useActiveSession.getState().startNew(exec, null);
    expect(useActiveSession.getState().session?.templateId).toBe(pull);
    await useActiveSession.getState().endWorkout(exec);
    await deleteTemplate(exec, pull);

    await useActiveSession.getState().startNew(exec, null);
    expect(useActiveSession.getState().session?.templateId).toBe(push);
  });

  it('按计划开训练时，计划里的每个动作都预建了待完成的组', async () => {
    const exec = await createMigratedExecutor();
    await setupTemplate(exec, '推日', ['卧推', '飞鸟']);

    await useActiveSession.getState().startNew(exec, null);

    // 和复制上一次那条路径一样：没有待完成的组，「完成这组」会毫无反应
    for (const item of useActiveSession.getState().exercises) {
      expect(item.sets.length).toBeGreaterThanOrEqual(1);
      expect(item.sets.every((s) => s.isCompleted === false)).toBe(true);
    }
  });
});

describe('训练中删动作', () => {
  beforeEach(() => {
    useActiveSession.getState().reset();
  });

  /** 开一场训练并加两个动作，A 做完 2 组、B 一组没做 */
  async function setupTwoExercises(exec: SqlExecutor) {
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const bench = await createCustomExercise(exec, '卧推', '胸', '杠铃');
    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().addExercise(exec, squat.id);
    await useActiveSession.getState().completeCurrentSet(exec, 100, 5);
    await useActiveSession.getState().completeCurrentSet(exec, 100, 5);
    await useActiveSession.getState().addExercise(exec, bench.id);
    return {
      sessionId: useActiveSession.getState().session!.id,
      squatSe: useActiveSession.getState().exercises[0].sessionExercise.id,
      benchSe: useActiveSession.getState().exercises[1].sessionExercise.id,
    };
  }

  it("mode: 'delete' 把动作和它的组一起删掉，清单里不再有它", async () => {
    const exec = await createMigratedExecutor();
    const { squatSe, benchSe } = await setupTwoExercises(exec);

    await useActiveSession.getState().removeExercise(exec, squatSe, 'delete');

    const { exercises } = useActiveSession.getState();
    expect(exercises.map((e) => e.exerciseName)).toEqual(['卧推']);
    expect(exercises[0].sessionExercise.id).toBe(benchSe);
    expect(await listSets(exec, squatSe)).toEqual([]);
  });

  it("mode: 'keep' 时动作从记录页消失，但练过的组留在库里", async () => {
    const exec = await createMigratedExecutor();
    const { squatSe } = await setupTwoExercises(exec);

    await useActiveSession.getState().removeExercise(exec, squatSe, 'keep');

    expect(useActiveSession.getState().exercises.map((e) => e.exerciseName)).toEqual([
      '卧推',
    ]);
    // 「先留着」= 练过的 2 组留在库里（进步曲线的点还在），
    // 未完成的占位组被删掉（否则这个动作的 sets 不为空，界面不会摘掉它，
    // 下次 resume 还会带着一个点不动的「完成这组」回来）
    const remaining = await listSets(exec, squatSe);
    expect(remaining).toHaveLength(2);
    expect(remaining.every((s) => s.isCompleted)).toBe(true);
  });

  it('删掉的正好是当前聚焦的动作时，currentIndex 被夹住而不是越界', async () => {
    const exec = await createMigratedExecutor();
    const { squatSe } = await setupTwoExercises(exec);
    // 当前停在第二个动作（卧推）上
    expect(useActiveSession.getState().currentIndex).toBe(1);

    await useActiveSession.getState().removeExercise(exec, squatSe, 'delete');

    const { exercises, currentIndex } = useActiveSession.getState();
    // 删掉第一个之后卧推变成第 0 个，指针必须跟着回到合法范围。
    // 不夹的话 exercises[1] 是 undefined，记录页会掉进
    // 「这次训练还没有动作」而库里其实还有动作 —— 比崩溃更难查。
    expect(currentIndex).toBe(0);
    expect(exercises[currentIndex]).toBeDefined();
    expect(exercises[currentIndex].exerciseName).toBe('卧推');
  });

  it('删光最后一个动作时，currentIndex 归 0 且清单为空', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().addExercise(exec, squat.id);
    const se = useActiveSession.getState().exercises[0].sessionExercise.id;

    await useActiveSession.getState().removeExercise(exec, se, 'delete');

    expect(useActiveSession.getState().exercises).toEqual([]);
    expect(useActiveSession.getState().currentIndex).toBe(0);
  });

  it('已结束的训练不接受删动作（防御闸门）', async () => {
    const exec = await createMigratedExecutor();
    const { sessionId, squatSe } = await setupTwoExercises(exec);
    await useActiveSession.getState().endWorkout(exec);

    // 模拟「有人绕过状态机，把一场已结束的训练塞回 store」
    const finished = await getSession(exec, sessionId);
    useActiveSession.setState({ session: finished });
    await useActiveSession.getState().removeExercise(exec, squatSe, 'delete');

    // 库里那个动作必须还在
    expect((await listSessionExercises(exec, sessionId)).map((se) => se.id)).toContain(
      squatSe,
    );
  });
});
