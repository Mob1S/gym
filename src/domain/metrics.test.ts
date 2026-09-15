import { totalVolumeLoad, estimateOneRepMax } from './metrics';

describe('totalVolumeLoad', () => {
  it('累加所有已完成组的 重量 × 次数', () => {
    const sets = [
      { weight: 100, reps: 5, isCompleted: true },
      { weight: 100, reps: 5, isCompleted: true },
      { weight: 100, reps: 3, isCompleted: true },
    ];
    expect(totalVolumeLoad(sets)).toBe(1300);
  });

  it('跳过未完成的组', () => {
    const sets = [
      { weight: 100, reps: 5, isCompleted: true },
      { weight: 100, reps: 5, isCompleted: false },
    ];
    expect(totalVolumeLoad(sets)).toBe(500);
  });

  it('空数组返回 0', () => {
    expect(totalVolumeLoad([])).toBe(0);
  });

  it('支持小数重量', () => {
    const sets = [{ weight: 2.5, reps: 10, isCompleted: true }];
    expect(totalVolumeLoad(sets)).toBe(25);
  });
});

describe('estimateOneRepMax', () => {
  it('次数为 1 时直接返回原重量', () => {
    expect(estimateOneRepMax(140, 1)).toBe(140);
  });

  it('次数大于 10 时返回 null（外推严重失真，必须不显示）', () => {
    expect(estimateOneRepMax(60, 11)).toBeNull();
    expect(estimateOneRepMax(60, 20)).toBeNull();
  });

  it('次数为 10 时仍然计算（上边界内）', () => {
    expect(estimateOneRepMax(100, 10)).not.toBeNull();
  });

  it('次数小于 1 时返回 null', () => {
    expect(estimateOneRepMax(100, 0)).toBeNull();
  });

  it('100kg × 5 次的结果在三公式平均的预期范围内', () => {
    // Epley:    100 * (1 + 5/30)      = 116.6667
    // Brzycki:  100 * 36 / 32         = 112.5
    // Lombardi: 100 * 5^0.1           = 117.4614
    // 平均                           = 115.5427
    const result = estimateOneRepMax(100, 5);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(115.54, 1);
  });

  it('e1RM 必定不小于原重量', () => {
    for (let reps = 2; reps <= 10; reps++) {
      const result = estimateOneRepMax(100, reps);
      expect(result!).toBeGreaterThanOrEqual(100);
    }
  });
});
