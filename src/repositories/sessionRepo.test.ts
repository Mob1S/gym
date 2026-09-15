import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import {
  addExerciseToSession,
  createSession,
  finishSession,
  getActiveSession,
  getSession,
  listSessionExercises,
  listSessions,
} from './sessionRepo';
import { createCustomExercise } from './exerciseRepo';

describe('sessionRepo', () => {
  it('新建的训练是进行中状态', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日');
    expect(s.name).toBe('腿部日');
    expect(s.finishedAt).toBeNull();
    expect(s.startedAt).toBeGreaterThan(0);
  });

  it('查得到刚建好的训练', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, null);
    const found = await getSession(exec, s.id);
    expect(found?.id).toBe(s.id);
    expect(found?.name).toBeNull();
  });

  it('getActiveSession 返回未结束的那一次', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日');
    const active = await getActiveSession(exec);
    expect(active?.id).toBe(s.id);
  });

  it('训练结束后 getActiveSession 返回 null', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日');
    await finishSession(exec, s.id, Date.now());
    expect(await getActiveSession(exec)).toBeNull();
  });

  it('存在多条未结束记录时只返回最新的一条（模拟崩溃后残留）', async () => {
    const exec = await createMigratedExecutor();
    await createSession(exec, '旧的一场');
    await new Promise((r) => setTimeout(r, 5));
    const newer = await createSession(exec, '新的一场');
    const active = await getActiveSession(exec);
    expect(active?.id).toBe(newer.id);
  });

  it('训练列表按开始时间倒序', async () => {
    const exec = await createMigratedExecutor();
    const first = await createSession(exec, '第一场');
    await new Promise((r) => setTimeout(r, 5));
    const second = await createSession(exec, '第二场');
    await finishSession(exec, first.id, Date.now());
    await finishSession(exec, second.id, Date.now());
    const list = await listSessions(exec, 10);
    expect(list.map((s) => s.name)).toEqual(['第二场', '第一场']);
  });

  it('往训练里加动作，position 从 0 开始递增', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日');
    const ex1 = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const ex2 = await createCustomExercise(exec, '腿举', '腿', '器械');
    const se1 = await addExerciseToSession(exec, s.id, ex1.id);
    const se2 = await addExerciseToSession(exec, s.id, ex2.id);
    expect(se1.position).toBe(0);
    expect(se2.position).toBe(1);
  });

  it('按 position 列出训练中的动作', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日');
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
      const s = await createSession(exec, `第 ${i} 场`);
      await finishSession(exec, s.id, Date.now());
    }
    expect((await listSessions(exec, 2)).length).toBe(2);
  });

  // 下面两条**故意不加 sleep**。started_at 是毫秒时间戳，同毫秒内连续建两场训练
  // 会让 ORDER BY started_at DESC 出现并列，SQLite 便按扫描顺序返回，结果不确定。
  // 加 rowid DESC 作为并列时的兜底（rowid 即插入顺序），语义才是确定的。

  it('同毫秒建的两场训练，getActiveSession 取后插入的那场', async () => {
    const exec = await createMigratedExecutor();
    const first = await createSession(exec, '先建的');
    const second = await createSession(exec, '后建的');
    expect(second.startedAt).toBe(first.startedAt); // 确认真的撞在同一毫秒

    const active = await getActiveSession(exec);
    expect(active?.id).toBe(second.id);
  });

  it('同毫秒建的两场训练，列表按后插入优先排列', async () => {
    const exec = await createMigratedExecutor();
    const first = await createSession(exec, '先建的');
    const second = await createSession(exec, '后建的');
    expect(second.startedAt).toBe(first.startedAt);

    await finishSession(exec, first.id, Date.now());
    await finishSession(exec, second.id, Date.now());

    const list = await listSessions(exec, 10);
    expect(list.map((s) => s.name)).toEqual(['后建的', '先建的']);
  });
});
