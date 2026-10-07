import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
// **从 importRecords import，不要从 csv import**：后者只是它的定义处，
// 前者是规范入口（见 importRecords.ts 里的再导出说明）。两处都写会让同一个
// 类型有两个来源，而「该从哪 import」这种问题每次都要重新想一遍。
import type { ImportedWorkout } from '../domain/importRecords';
import { listExercises } from './exerciseRepo';
import { importWorkouts } from './importRepo';
import { listCompletedSetPoints } from './progressRepo';
import { listSessionSummaries } from './sessionRepo';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

/** 造一场导入用的训练。组默认 60kg×8。 */
function workout(overrides: Partial<ImportedWorkout> = {}): ImportedWorkout {
  return {
    startedAt: T0,
    finishedAt: T0 + 3_600_000,
    name: '推日',
    exercises: [{ name: '卧推', sets: [{ weight: 60, reps: 8 }] }],
    ...overrides,
  };
}

describe('importWorkouts', () => {
  it('一场训练连同它的动作与组一起落库', async () => {
    const exec = await createMigratedExecutor();

    const result = await importWorkouts(exec, [workout()]);

    expect(result).toEqual({ sessions: 1, exercises: 1, createdExercises: 1 });
    const summaries = await listSessionSummaries(exec, 10);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].setCount).toBe(1);
    expect(summaries[0].volumeKg).toBe(480);
  });

  it('导进来的记录出现在进步曲线里（这是整个功能的重点）', async () => {
    const exec = await createMigratedExecutor();

    await importWorkouts(exec, [workout()]);

    const points = await listCompletedSetPoints(exec);
    // 进步曲线只认「已完成 + 属于一场已结束的训练」，导入的记录必须两条都满足
    expect(points).toHaveLength(1);
    expect(points[0].weight).toBe(60);
    expect(points[0].reps).toBe(8);
  });

  it('同名动作只新建一次（42 场里出现 300 次也只建一条）', async () => {
    const exec = await createMigratedExecutor();
    const many: ImportedWorkout[] = [];
    for (let day = 0; day < 5; day += 1) {
      many.push(
        workout({
          startedAt: T0 + day * DAY,
          finishedAt: T0 + day * DAY + 3_600_000,
          exercises: [
            { name: '卧推', sets: [{ weight: 60, reps: 8 }] },
            { name: '卧推', sets: [{ weight: 65, reps: 6 }] },
          ],
        }),
      );
    }

    const result = await importWorkouts(exec, many);

    // 动作库里只有一条「卧推」。建重了的话，进步曲线会被切成好几段。
    const exercises = await listExercises(exec);
    expect(exercises.filter((e) => e.name === '卧推')).toHaveLength(1);
    expect(result.createdExercises).toBe(1);
  });

  it('同一场里同名的动作合并成一个，组按顺序排', async () => {
    const exec = await createMigratedExecutor();

    await importWorkouts(exec, [
      workout({
        exercises: [
          { name: '卧推', sets: [{ weight: 60, reps: 8 }] },
          { name: '深蹲', sets: [{ weight: 100, reps: 5 }] },
          { name: '卧推', sets: [{ weight: 65, reps: 6 }] },
        ],
      }),
    ]);

    const points = await listCompletedSetPoints(exec);
    const bench = points.filter((p) => p.weight !== 100);
    expect(bench.map((p) => p.weight)).toEqual([60, 65]);
  });

  it('库里已有的同名动作被复用，不新建', async () => {
    const exec = await createMigratedExecutor();
    // 大小写与全角差异都要能匹配上
    await importWorkouts(exec, [
      workout({ exercises: [{ name: 'Bench Press', sets: [{ weight: 60, reps: 8 }] }] }),
    ]);

    const result = await importWorkouts(exec, [
      workout({
        startedAt: T0 + DAY,
        // `finishedAt` 必须跟着顺延：`workout()` 的默认它停在 T0 + 1h，
        // 只改 startedAt 会得到「结束早于开始」，被校验层整批拒掉（第 3 条用例
        // 就是拿这个当反例的）
        finishedAt: T0 + DAY + 3_600_000,
        exercises: [{ name: 'Ｂｅｎｃｈ　Ｐｒｅｓｓ', sets: [{ weight: 62.5, reps: 8 }] }],
      }),
    ]);

    expect(result.createdExercises).toBe(0);
    expect((await listExercises(exec)).filter((e) => e.name === 'Bench Press')).toHaveLength(1);
    // 两场的点挂在同一个动作上，曲线是连着的
    const points = await listCompletedSetPoints(exec);
    expect(new Set(points.map((p) => p.exerciseId)).size).toBe(1);
  });

  it('导进来的每一组都直接是已完成，不留下任何占位组', async () => {
    const exec = await createMigratedExecutor();

    await importWorkouts(exec, [workout()]);

    const total = await exec.first<{ n: number }>(
      'SELECT COUNT(*) AS n FROM set_entry',
    );
    const unfinished = await exec.first<{ n: number }>(
      'SELECT COUNT(*) AS n FROM set_entry WHERE is_completed = 0',
    );
    // 导入的场次 finished_at 非空，记录页根本不会打开它，所以**不需要**预建占位组。
    // 凭空补一条 is_completed = 0 的行反而是编造数据：它没有真实的重量与次数
    // （只能写 0/0），而 set_entry 里每一行都该是用户真的做过的一组。
    // 这条断言同时挡住「将来有人为了复用记录页而给导入的场次补占位」。
    expect(Number(total?.n ?? 0)).toBe(1);
    expect(Number(unfinished?.n ?? 0)).toBe(0);
  });

  it('中途失败时整体回滚：库里一行都不多', async () => {
    const exec = await createMigratedExecutor();
    // 第二条的动作名不是字符串。校验层会拦下它，但我们要测的是**仓储自己**
    // 在写坏数据时的回滚，所以绕过校验直接喂进去。
    const broken = {
      startedAt: T0 + DAY,
      finishedAt: T0 + DAY + 3_600_000,
      name: null,
      exercises: [{ name: 123 as unknown as string, sets: [{ weight: 60, reps: 8 }] }],
    };

    await expect(
      importWorkouts(exec, [workout(), broken]),
    ).rejects.toThrow();

    // 第一条也不许留下来 —— 半个文件导进去比一条都没导更糟
    expect(await listSessionSummaries(exec, 10)).toEqual([]);
    expect(await listExercises(exec)).toEqual([]);
  });

  it('空数组时什么都不做，也不报错', async () => {
    const exec = await createMigratedExecutor();
    expect(await importWorkouts(exec, [])).toEqual({
      sessions: 0,
      exercises: 0,
      createdExercises: 0,
    });
  });
});
