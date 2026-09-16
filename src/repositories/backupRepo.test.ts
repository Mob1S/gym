import type { SqlExecutor } from '../db/types';
import { SCHEMA_VERSION } from '../db/types';
import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  buildBackup,
  validateBackup,
} from '../domain/backup';
import type { BackupData } from '../domain/backup';
import type { SetEntry } from '../domain/types';
import { createCustomExercise } from './exerciseRepo';
import {
  addExerciseToSession,
  createSession,
  listSessionExercises,
  listSessionSummaries,
} from './sessionRepo';
import { addSet, completeSet, endRest, listSets, startRest } from './setRepo';
import { exportAll, importAll } from './backupRepo';

const MINUTE = 60_000;

/** 固定时钟。导出会写 exportedAt，绝不能让断言依赖真实时间。 */
const NOW = 1_789_560_000_000;
const T0 = NOW - 3_600_000;

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** 手工构造一份「最小但完整」的备份数据，用来喂给 importAll / 断言导出形状 */
function makeData(overrides: Partial<BackupData> = {}): BackupData {
  return {
    exercises: [
      {
        id: 'ex-1',
        name: '卧推',
        muscleGroup: '胸',
        equipment: '杠铃',
        isCustom: true,
        isArchived: false,
        createdAt: T0,
      },
    ],
    sessions: [
      {
        id: 'sess-1',
        name: '推日',
        startedAt: T0,
        finishedAt: T0 + 45 * MINUTE,
        note: null,
      },
    ],
    sessionExercises: [
      { id: 'se-1', sessionId: 'sess-1', exerciseId: 'ex-1', position: 0, note: null },
    ],
    sets: [
      {
        id: 'set-1',
        sessionExerciseId: 'se-1',
        position: 0,
        weight: 60,
        reps: 8,
        isCompleted: true,
        restSeconds: 120,
        restStartedAt: null,
        completedAt: T0 + MINUTE,
      },
    ],
    ...overrides,
  };
}

function makeSet(overrides: Partial<SetEntry> = {}): SetEntry {
  return {
    id: 'set-1',
    sessionExerciseId: 'se-1',
    position: 0,
    weight: 60,
    reps: 8,
    isCompleted: true,
    restSeconds: 120,
    restStartedAt: null,
    completedAt: T0 + MINUTE,
    ...overrides,
  };
}

/**
 * 造一个四张表都有数据的库，覆盖几个容易在导出时被漏掉的东西：
 * 归档动作（`listExercises` 看不到它，但它必须在备份里）、
 * 进行中的训练（`finished_at` 为 NULL）、休息字段为 NULL 的组。
 */
async function seedLibrary(exec: SqlExecutor): Promise<void> {
  const bench = await createCustomExercise(exec, '卧推', '胸', '杠铃');
  const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
  const ancient = await createCustomExercise(exec, '上古动作', null, null);
  await exec.run('UPDATE exercise SET is_archived = 1 WHERE id = ?', [ancient.id]);

  const push = await createSession(exec, '推日');
  await exec.run(
    'UPDATE session SET started_at = ?, finished_at = ?, note = ? WHERE id = ?',
    [T0, T0 + 50 * MINUTE, '状态不错', push.id],
  );
  const seBench = await addExerciseToSession(exec, push.id, bench.id);
  const seSquat = await addExerciseToSession(exec, push.id, squat.id);

  const warm = await addSet(exec, seBench.id, 40, 10);
  await completeSet(exec, warm.id, T0 + 2 * MINUTE);
  await startRest(exec, warm.id, T0 + 2 * MINUTE);
  await endRest(exec, warm.id, T0 + 3 * MINUTE + 30_000); // rest_seconds = 90

  const heavy = await addSet(exec, seBench.id, 80, 5);
  await completeSet(exec, heavy.id, T0 + 6 * MINUTE);

  await addSet(exec, seSquat.id, 100, 5); // 未完成、没有休息记录

  // 进行中的训练：finished_at 为 NULL，也必须在备份里
  const ongoing = await createSession(exec, '正在练');
  await exec.run('UPDATE session SET started_at = ? WHERE id = ?', [
    T0 + 90 * MINUTE,
    ongoing.id,
  ]);
  await addExerciseToSession(exec, ongoing.id, squat.id);
}

/** 不经过 exportAll 的原始快照，用来验证「数据一个字节都没变」 */
async function snapshot(exec: SqlExecutor) {
  return {
    exercises: await exec.all('SELECT * FROM exercise ORDER BY rowid'),
    sessions: await exec.all('SELECT * FROM session ORDER BY rowid'),
    sessionExercises: await exec.all('SELECT * FROM session_exercise ORDER BY rowid'),
    sets: await exec.all('SELECT * FROM set_entry ORDER BY rowid'),
  };
}

async function counts(exec: SqlExecutor) {
  const one = async (table: string) => {
    const row = await exec.first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table}`,
    );
    return row?.count ?? -1;
  };
  return {
    exercises: await one('exercise'),
    sessions: await one('session'),
    sessionExercises: await one('session_exercise'),
    sets: await one('set_entry'),
  };
}

describe('exportAll', () => {
  it('空库：四个数组都是空的，format / version / schemaVersion / exportedAt 正确', async () => {
    const exec = await createMigratedExecutor();
    const backup = await exportAll(exec);

    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.schemaVersion).toBe(SCHEMA_VERSION);
    expect(backup.exportedAt).toBe(NOW);
    expect(backup.data.exercises).toEqual([]);
    expect(backup.data.sessions).toEqual([]);
    expect(backup.data.sessionExercises).toEqual([]);
    expect(backup.data.sets).toEqual([]);
  });

  it('有数据的库：四张表条数正确', async () => {
    const exec = await createMigratedExecutor();
    await seedLibrary(exec);

    const backup = await exportAll(exec);
    expect(backup.data.exercises).toHaveLength(3);
    expect(backup.data.sessions).toHaveLength(2);
    expect(backup.data.sessionExercises).toHaveLength(3);
    expect(backup.data.sets).toHaveLength(3);
    expect(backup.data.exercises.map((e) => e.name).sort()).toEqual([
      '上古动作',
      '卧推',
      '深蹲',
    ]);
  });

  it('字段是驼峰，一个下划线都不许有', async () => {
    const exec = await createMigratedExecutor();
    await seedLibrary(exec);

    const { data } = await exportAll(exec);
    expect(Object.keys(data.exercises[0])).toEqual([
      'id',
      'name',
      'muscleGroup',
      'equipment',
      'isCustom',
      'isArchived',
      'createdAt',
    ]);
    expect(Object.keys(data.sets[0])).toEqual([
      'id',
      'sessionExerciseId',
      'position',
      'weight',
      'reps',
      'isCompleted',
      'restSeconds',
      'restStartedAt',
      'completedAt',
    ]);

    const rows: object[] = [
      ...data.exercises,
      ...data.sessions,
      ...data.sessionExercises,
      ...data.sets,
    ];
    for (const row of rows) {
      expect(Object.keys(row).filter((key) => key.includes('_'))).toEqual([]);
    }
  });

  it('内容与库里的值一致：归档动作、进行中训练、null 休息字段都在', async () => {
    const exec = await createMigratedExecutor();
    await seedLibrary(exec);

    const { data } = await exportAll(exec);

    const ancient = data.exercises.find((e) => e.name === '上古动作');
    expect(ancient).toMatchObject({
      muscleGroup: null,
      equipment: null,
      isArchived: true,
      isCustom: true,
    });
    const bench = data.exercises.find((e) => e.name === '卧推');
    expect(bench).toMatchObject({ muscleGroup: '胸', equipment: '杠铃', createdAt: NOW });

    const ongoing = data.sessions.find((s) => s.name === '正在练');
    expect(ongoing?.finishedAt).toBeNull();
    expect(data.sessions.find((s) => s.name === '推日')).toMatchObject({
      startedAt: T0,
      finishedAt: T0 + 50 * MINUTE,
      note: '状态不错',
    });

    const warm = data.sets.find((s) => s.weight === 40);
    expect(warm).toMatchObject({
      reps: 10,
      isCompleted: true,
      restSeconds: 90,
      restStartedAt: null,
      completedAt: T0 + 2 * MINUTE,
    });
    const pending = data.sets.find((s) => s.isCompleted === false);
    expect(pending).toMatchObject({
      weight: 100,
      reps: 5,
      restSeconds: null,
      restStartedAt: null,
      completedAt: null,
    });
  });

  it('导出的文件能通过自己的校验（字段名漂移成 snake_case 会在这里炸）', async () => {
    const exec = await createMigratedExecutor();
    await seedLibrary(exec);

    // 过一遍 JSON：真实导出会先落盘成 JSON，再读回来校验
    const written = JSON.parse(JSON.stringify(await exportAll(exec)));
    const result = validateBackup(written);
    if (!result.ok) throw new Error(`导出的文件没通过自己的校验：${result.reason}`);
    expect(result.ok).toBe(true);
  });
});

describe('importAll', () => {
  it('往返一致性：导出 → 导入到另一个空库 → 两边内容完全一致', async () => {
    const source = await createMigratedExecutor();
    await seedLibrary(source);
    const backup = await exportAll(source);

    const target = await createMigratedExecutor();
    await importAll(target, backup);

    expect(await exportAll(target)).toEqual(backup);
    expect(await snapshot(target)).toEqual(await snapshot(source));
  });

  it('整体替换：目标库原有的数据全部消失，只剩备份里的', async () => {
    const source = await createMigratedExecutor();
    await seedLibrary(source);
    const backup = await exportAll(source);

    const target = await createMigratedExecutor();
    const staleExercise = await createCustomExercise(target, '目标库的旧动作', '背', null);
    const staleSession = await createSession(target, '目标库的旧训练');
    const staleSe = await addExerciseToSession(target, staleSession.id, staleExercise.id);
    await addSet(target, staleSe.id, 999, 9);

    await importAll(target, backup);

    expect(await counts(target)).toEqual({
      exercises: 3,
      sessions: 2,
      sessionExercises: 3,
      sets: 3,
    });
    expect(await exportAll(target)).toEqual(backup);
    expect(await snapshot(target)).toEqual(await snapshot(source));
    const ids = (await snapshot(target)).sessions.map(
      (row) => (row as { id: string }).id,
    );
    expect(ids).not.toContain(staleSession.id);
  });

  it('position 原样保持，不重新编号', async () => {
    const exec = await createMigratedExecutor();
    await importAll(
      exec,
      buildBackup(
        makeData({
          sessionExercises: [
            { id: 'se-1', sessionId: 'sess-1', exerciseId: 'ex-1', position: 7, note: null },
            {
              id: 'se-2',
              sessionId: 'sess-1',
              exerciseId: 'ex-1',
              position: 9,
              note: '第二个动作',
            },
          ],
          sets: [
            makeSet({ id: 'set-1', sessionExerciseId: 'se-1', position: 42 }),
            makeSet({ id: 'set-2', sessionExerciseId: 'se-1', position: 43 }),
          ],
        }),
        SCHEMA_VERSION,
        NOW,
      ),
    );

    expect((await listSessionExercises(exec, 'sess-1')).map((se) => se.position)).toEqual([
      7, 9,
    ]);
    expect((await listSets(exec, 'se-1')).map((set) => set.position)).toEqual([42, 43]);
    expect((await listSessionExercises(exec, 'sess-1'))[1].note).toBe('第二个动作');
  });

  it('中途失败会整体回滚，库里的数据与调用前完全一致', async () => {
    const exec = await createMigratedExecutor();
    await seedLibrary(exec);
    const before = await snapshot(exec);
    // 前置断言：库里确实有数据。否则「数据没变」是句空话，测不出任何东西
    expect(before.exercises).toHaveLength(3);
    expect(before.sets).toHaveLength(3);

    // 绕过 validateBackup 直接构造：这条测的是 importAll 自己兜不兜得住，
    // 不是校验拦不拦得住，所以不能依赖 validateBackup 的引用完整性检查。
    const broken = buildBackup(
      makeData({
        sets: [makeSet({ id: 'set-坏', sessionExerciseId: 'se-不存在' })],
      }),
      SCHEMA_VERSION,
      NOW,
    );
    // 这份数据确实是「校验也拦得住」的坏数据（说明它坏得名副其实）
    expect(validateBackup(broken).ok).toBe(false);

    // DELETE 都跑完了、插入插到一半才炸：抛的必须是原始的 SQLite 异常，不是被包装过的
    await expect(importAll(exec, broken)).rejects.toThrow(/FOREIGN KEY/i);

    expect(await snapshot(exec)).toEqual(before);
  });

  it('导入一份合法的空备份 → 库被清空（这是合法行为，不是错误）', async () => {
    const exec = await createMigratedExecutor();
    await seedLibrary(exec);

    const empty = buildBackup(
      { exercises: [], sessions: [], sessionExercises: [], sets: [] },
      SCHEMA_VERSION,
      NOW,
    );
    expect(validateBackup(empty).ok).toBe(true);

    await importAll(exec, empty);

    expect(await counts(exec)).toEqual({
      exercises: 0,
      sessions: 0,
      sessionExercises: 0,
      sets: 0,
    });
  });

  it('导入后 listSessionSummaries 能正确算出容量（端到端）', async () => {
    const exec = await createMigratedExecutor();
    await importAll(
      exec,
      buildBackup(
        makeData({
          sets: [
            makeSet({
              id: 'set-1',
              position: 0,
              weight: 100,
              reps: 5,
              isCompleted: true,
              completedAt: T0 + MINUTE,
            }),
            makeSet({
              id: 'set-2',
              position: 1,
              weight: 100,
              reps: 5,
              isCompleted: false,
              restSeconds: null,
              completedAt: null,
            }),
          ],
        }),
        SCHEMA_VERSION,
        NOW,
      ),
    );

    const [row] = await listSessionSummaries(exec, 10);
    expect(row.name).toBe('推日');
    expect(row.setCount).toBe(1);
    expect(row.volumeKg).toBe(500);
    expect(row.durationMinutes).toBe(45);
  });

  it('导出按插入顺序（rowid），不是 id 字典序：同毫秒的训练往返后顺序不变', async () => {
    // 三个 id 刻意选成：字典序升序、降序**都不等于**插入顺序
    // （插入顺序 m-first → z-second → a-third）
    const source = await createMigratedExecutor();
    await importAll(
      source,
      buildBackup(
        makeData({
          sessions: [
            { id: 'm-first', name: '先建', startedAt: T0, finishedAt: T0 + MINUTE, note: null },
            { id: 'z-second', name: '中间', startedAt: T0, finishedAt: T0 + MINUTE, note: null },
            { id: 'a-third', name: '后建', startedAt: T0, finishedAt: T0 + MINUTE, note: null },
          ],
          sessionExercises: [],
          sets: [],
        }),
        SCHEMA_VERSION,
        NOW,
      ),
    );

    expect((await exportAll(source)).data.sessions.map((s) => s.id)).toEqual([
      'm-first',
      'z-second',
      'a-third',
    ]);

    // 历史列表用 `started_at DESC, rowid DESC` 排序，所以「同毫秒时谁在前」完全
    // 取决于插入顺序 —— 导出必须保住这个顺序，否则恢复出来的历史顺序会翻过来。
    const target = await createMigratedExecutor();
    await importAll(target, await exportAll(source));

    const expected = ['后建', '中间', '先建'];
    expect((await listSessionSummaries(source, 10)).map((r) => r.name)).toEqual(expected);
    expect((await listSessionSummaries(target, 10)).map((r) => r.name)).toEqual(expected);
  });
});
