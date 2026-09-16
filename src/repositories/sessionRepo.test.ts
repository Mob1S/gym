import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import type { SqlExecutor } from '../db/types';
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

  // 下面两条验的是 `ORDER BY started_at DESC, rowid DESC` 里的 rowid 兜底：
  // started_at 撞在同一毫秒时，SQLite 会退化成按扫描顺序返回（即先插入的在前），
  // 语义就反了，必须靠 rowid 才确定。

  // 关键：**不要靠"连续两次 createSession 恰好落在同一毫秒"来制造并列**。
  // 那是在赌时钟，机器一忙两次调用跨过毫秒边界，断言就随机炸（实测 20 次全量
  // 里闪 2 次）。这里显式把两行的时间戳改成同一个值，让并列成为确定事件 ——
  // 这样测的是 SQL 的排序语义本身，而不是运气。
  const FORCED_TIE = 1_700_000_000_000;

  async function seedTiedSessions(exec: SqlExecutor) {
    const first = await createSession(exec, '先建的');
    const second = await createSession(exec, '后建的');
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
});
