import { normalizeExerciseName, validateImportedWorkouts } from './importRecords';
// 走规范入口 importRecords（它再导出），不直接找 csv —— 见 Task 15 开头那条约定
import type { ImportedWorkout } from './importRecords';

function workout(overrides: Partial<ImportedWorkout> = {}): ImportedWorkout {
  return {
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_003_600_000,
    name: '推日',
    exercises: [{ name: '卧推', sets: [{ weight: 60, reps: 8 }] }],
    ...overrides,
  };
}

describe('normalizeExerciseName', () => {
  it('去首尾空格、折叠中间空白', () => {
    expect(normalizeExerciseName('  卧  推 ')).toBe('卧推');
  });

  it('全角转半角（括号、字母、数字）', () => {
    // 别的 App 导出的名字常常是全角，本机动作库是半角。
    // 不归一化的话「卧推（窄距）」和「卧推(窄距)」会变成两个动作，
    // 进步曲线被切成两段 —— 这是导入功能最容易踩、事后最难修的坑。
    expect(normalizeExerciseName('卧推（窄距）')).toBe('卧推(窄距)');
    // 全角转半角与大小写折叠是两件事：`Ｂｅｎｃｈ` 先变 `Bench`，再折叠成 `bench`。
    // 断言只写 'Bench' 会让人以为这一步不折叠大小写（下面那条测试要求折叠）。
    expect(normalizeExerciseName('Ｂｅｎｃｈ')).toBe('bench');
  });

  it('英文统一小写，大小写不同的同一个动作归一成一样', () => {
    expect(normalizeExerciseName('Bench Press')).toBe(
      normalizeExerciseName('bench press'),
    );
  });
});

describe('validateImportedWorkouts', () => {
  it('正常的一份通过', () => {
    expect(validateImportedWorkouts([workout()])).toEqual({ ok: true });
  });

  it('结束时间早于开始时间时被拒', () => {
    const result = validateImportedWorkouts([
      workout({ startedAt: 2000, finishedAt: 1000 }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('结束时间');
  });

  it('一个动作都没有的训练被拒', () => {
    const result = validateImportedWorkouts([workout({ exercises: [] })]);
    expect(result.ok).toBe(false);
  });

  it('有动作但一组都没有时也被拒', () => {
    // 空训练进了库就是一条点开什么都没有的历史记录，用户既看不懂也删不掉
    const result = validateImportedWorkouts([
      workout({ exercises: [{ name: '卧推', sets: [] }] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('一组');
  });

  it('空数组直接通过（没有东西要导）', () => {
    expect(validateImportedWorkouts([])).toEqual({ ok: true });
  });
});
