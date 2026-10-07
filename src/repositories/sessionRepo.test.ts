import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import type { SqlExecutor } from '../db/types';
import {
  addExerciseToSession,
  createSession,
  deleteIncompleteSetsOf,
  deleteSession,
  deleteSessionExercise,
  findLastActiveSessionExerciseId,
  finishSession,
  getActiveSession,
  getSession,
  listSessionExercises,
  listSessions,
} from './sessionRepo';
import { createCustomExercise, listExercises } from './exerciseRepo';
import { addSet, completeSet, listSets } from './setRepo';

describe('sessionRepo', () => {
  it('新建的训练是进行中状态', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日', null);
    expect(s.name).toBe('腿部日');
    expect(s.finishedAt).toBeNull();
    expect(s.startedAt).toBeGreaterThan(0);
  });

  it('查得到刚建好的训练', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, null, null);
    const found = await getSession(exec, s.id);
    expect(found?.id).toBe(s.id);
    expect(found?.name).toBeNull();
  });

  it('getActiveSession 返回未结束的那一次', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日', null);
    const active = await getActiveSession(exec);
    expect(active?.id).toBe(s.id);
  });

  it('训练结束后 getActiveSession 返回 null', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日', null);
    await finishSession(exec, s.id, Date.now());
    expect(await getActiveSession(exec)).toBeNull();
  });

  it('存在多条未结束记录时只返回最新的一条（模拟崩溃后残留）', async () => {
    const exec = await createMigratedExecutor();
    await createSession(exec, '旧的一场', null);
    await new Promise((r) => setTimeout(r, 5));
    const newer = await createSession(exec, '新的一场', null);
    const active = await getActiveSession(exec);
    expect(active?.id).toBe(newer.id);
  });

  it('训练列表按开始时间倒序', async () => {
    const exec = await createMigratedExecutor();
    const first = await createSession(exec, '第一场', null);
    await new Promise((r) => setTimeout(r, 5));
    const second = await createSession(exec, '第二场', null);
    await finishSession(exec, first.id, Date.now());
    await finishSession(exec, second.id, Date.now());
    const list = await listSessions(exec, 10);
    expect(list.map((s) => s.name)).toEqual(['第二场', '第一场']);
  });

  it('往训练里加动作，position 从 0 开始递增', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日', null);
    const ex1 = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const ex2 = await createCustomExercise(exec, '腿举', '腿', '器械');
    const se1 = await addExerciseToSession(exec, s.id, ex1.id);
    const se2 = await addExerciseToSession(exec, s.id, ex2.id);
    expect(se1.position).toBe(0);
    expect(se2.position).toBe(1);
  });

  it('按 position 列出训练中的动作', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日', null);
    const ex1 = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const ex2 = await createCustomExercise(exec, '腿举', '腿', '器械');
    await addExerciseToSession(exec, s.id, ex2.id);
    await addExerciseToSession(exec, s.id, ex1.id);
    const list = await listSessionExercises(exec, s.id);
    expect(list.map((se) => se.exerciseId)).toEqual([ex2.id, ex1.id]);
  });

  it('listSessions 尊重 limit', async () => {
    const exec = await createMigratedExecutor();
    for (let i = 0; i < 5; i++) {
      const s = await createSession(exec, `第 ${i} 场`, null);
      await finishSession(exec, s.id, Date.now());
    }
    expect((await listSessions(exec, 2)).length).toBe(2);
  });

  // 下面两条验的是 `ORDER BY started_at DESC, rowid DESC` 里的 rowid 兜底：
  // started_at 撞在同一毫秒时，SQLite 会退化成按扫描顺序返回（即先插入的在前），
  // 语义就反了，必须靠 rowid 才确定。

  // 关键：**不要靠"连续两次 createSession 恰好落在同一毫秒"来制造并列**。
  // 那是在赌时钟，机器一忙两次调用跨过毫秒边界，断言就随机炸（实测 20 次全量
  // 里闪 2 次）。这里显式把两行的时间戳改成同一个值，让并列成为确定事件 ——
  // 这样测的是 SQL 的排序语义本身，而不是运气。
  const FORCED_TIE = 1_700_000_000_000;

  async function seedTiedSessions(exec: SqlExecutor) {
    const first = await createSession(exec, '先建的', null);
    const second = await createSession(exec, '后建的', null);
    await exec.run('UPDATE session SET started_at = ? WHERE id = ?', [
      FORCED_TIE,
      first.id,
    ]);
    await exec.run('UPDATE session SET started_at = ? WHERE id = ?', [
      FORCED_TIE,
      second.id,
    ]);
    return { first, second };
  }

  it('同毫秒建的两场训练，getActiveSession 取后插入的那场', async () => {
    const exec = await createMigratedExecutor();
    const { second } = await seedTiedSessions(exec);

    const active = await getActiveSession(exec);
    expect(active?.id).toBe(second.id);
  });

  it('同毫秒建的两场训练，列表按后插入优先排列', async () => {
    const exec = await createMigratedExecutor();
    const { first, second } = await seedTiedSessions(exec);

    await finishSession(exec, first.id, Date.now());
    await finishSession(exec, second.id, Date.now());

    const list = await listSessions(exec, 10);
    expect(list.map((s) => s.name)).toEqual(['后建的', '先建的']);
  });

  it('findLastActiveSessionExerciseId 取最近做过组的那个动作', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日', null);
    const ex1 = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const ex2 = await createCustomExercise(exec, '腿举', '腿', '器械');
    const se1 = await addExerciseToSession(exec, s.id, ex1.id);
    const se2 = await addExerciseToSession(exec, s.id, ex2.id);

    const first = await addSet(exec, se1.id, 100, 5);
    await completeSet(exec, first.id, 1_000);
    const second = await addSet(exec, se2.id, 50, 10);
    await completeSet(exec, second.id, 2_000);

    expect(await findLastActiveSessionExerciseId(exec, s.id)).toBe(se2.id);
  });

  it('一组都没完成时返回 null', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日', null);
    const ex1 = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const se1 = await addExerciseToSession(exec, s.id, ex1.id);
    await addSet(exec, se1.id, 100, 5); // 建出来但没完成

    expect(await findLastActiveSessionExerciseId(exec, s.id)).toBeNull();
  });

  it('只看这一场训练：别的训练里做过的组不算数', async () => {
    const exec = await createMigratedExecutor();
    const ex = await createCustomExercise(exec, '深蹲', '腿', '杠铃');

    const other = await createSession(exec, '别的一场', null);
    const seOther = await addExerciseToSession(exec, other.id, ex.id);
    const done = await addSet(exec, seOther.id, 100, 5);
    await completeSet(exec, done.id, 5_000);

    const s = await createSession(exec, '这一场', null);
    const se = await addExerciseToSession(exec, s.id, ex.id);
    await addSet(exec, se.id, 100, 5);

    expect(await findLastActiveSessionExerciseId(exec, s.id)).toBeNull();
  });
});

describe('删除训练记录', () => {
  /** 造一场「2 个动作、每个动作 2 组已完成」的训练，返回各个 id */
  async function setupSessionWithSets(exec: SqlExecutor) {
    const session = await createSession(exec, '腿部日', null);
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const bench = await createCustomExercise(exec, '卧推', '胸', '杠铃');
    const seSquat = await addExerciseToSession(exec, session.id, squat.id);
    const seBench = await addExerciseToSession(exec, session.id, bench.id);

    for (const se of [seSquat, seBench]) {
      for (const weight of [100, 105]) {
        const set = await addSet(exec, se.id, weight, 5);
        await completeSet(exec, set.id, Date.now());
      }
    }
    await finishSession(exec, session.id, Date.now());
    return { session, seSquat, seBench };
  }

  it('删一场训练，它的动作与组一起消失（靠外键级联）', async () => {
    const exec = await createMigratedExecutor();
    const { session, seSquat } = await setupSessionWithSets(exec);

    await deleteSession(exec, session.id);

    expect(await getSession(exec, session.id)).toBeNull();
    expect(await listSessionExercises(exec, session.id)).toEqual([]);
    expect(await listSets(exec, seSquat.id)).toEqual([]);
    // 动作库本身不能被牵连
    expect(await listExercises(exec)).toHaveLength(2);
  });

  it('只删掉目标那一场，别的场次一组不少', async () => {
    const exec = await createMigratedExecutor();
    const first = await setupSessionWithSets(exec);
    const second = await setupSessionWithSets(exec);

    await deleteSession(exec, first.session.id);

    expect(await getSession(exec, second.session.id)).not.toBeNull();
    expect(await listSets(exec, second.seSquat.id)).toHaveLength(2);
  });

  it('删掉进行中的那一场之后，getActiveSession 返回 null', async () => {
    const exec = await createMigratedExecutor();
    // 进行中的那一场：不调 finishSession
    const session = await createSession(exec, '没结束的训练', null);
    expect(await getActiveSession(exec)).not.toBeNull();

    await deleteSession(exec, session.id);

    // 首页的「继续训练」就是看这个查询的返回值；不清干净的话它会指向
    // 一条已经不存在的记录，点进去是一屏空白
    expect(await getActiveSession(exec)).toBeNull();
  });

  it('deleteSessionExercise 把组和动作一起删掉，并重排后面的 position', async () => {
    const exec = await createMigratedExecutor();
    const { session, seSquat } = await setupSessionWithSets(exec);

    const removedSets = await deleteSessionExercise(exec, seSquat.id);

    expect(removedSets).toBe(2);
    expect(await listSets(exec, seSquat.id)).toEqual([]);
    const remaining = await listSessionExercises(exec, session.id);
    expect(remaining).toHaveLength(1);
    // 剩下的那个原本是 position 1，删掉 0 之后必须变成 0。
    // 留着空洞 order by 也还能用，但以后要插到中间就会错位。
    expect(remaining[0].position).toBe(0);
  });

  it('deleteIncompleteSetsOf 删掉占位组、留下已完成的组，动作这一条还在', async () => {
    const exec = await createMigratedExecutor();
    const { session, seSquat } = await setupSessionWithSets(exec);
    // `setupSessionWithSets` 造的都是已完成的组，先补一条占位组进去
    // —— 真实流程里 `completeCurrentSet` 每完成一组都会预建一条
    await addSet(exec, seSquat.id, 105, 5);

    const removed = await deleteIncompleteSetsOf(exec, seSquat.id);

    expect(removed).toBe(1);
    const remaining = await listSets(exec, seSquat.id);
    // 练过的 2 组必须还在：进步曲线只认已完成且属于某场训练的组，
    // 用户选的是「别删我的记录」，不是「抹掉历史」
    expect(remaining).toHaveLength(2);
    expect(remaining.every((s) => s.isCompleted)).toBe(true);
    // 动作还在，position 也不动 —— 界面靠「这个动作的 sets 为空」把它摘掉
    expect((await listSessionExercises(exec, session.id)).map((se) => se.id)).toContain(
      seSquat.id,
    );
  });
});
