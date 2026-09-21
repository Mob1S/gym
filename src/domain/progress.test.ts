import { buildProgressPoints, summarizeProgress, toSeries } from './progress';

/**
 * 一组真实形状的数据：深蹲四次训练，每次的组都不一样。
 * e1RM 用 metrics.ts 的三个公式手算过：
 *   55×10 → 71.97 / 60×10 → 78.51 / 65×5 → 75.10 / 70×3 → 76.42
 * 注意 60×10 的重量最低，e1RM 却最高 —— 这条语义最容易搞错，专门锁住。
 */
const FOUR_SESSIONS = [
  { sessionId: 's1', startedAt: 1_000, weight: 55, reps: 10 },
  { sessionId: 's2', startedAt: 2_000, weight: 60, reps: 10 },
  { sessionId: 's3', startedAt: 3_000, weight: 65, reps: 5 },
  { sessionId: 's4', startedAt: 4_000, weight: 70, reps: 3 },
];

describe('buildProgressPoints', () => {
  it('一次训练出一个点，不是一组一个点', () => {
    const points = buildProgressPoints([
      { sessionId: 's1', startedAt: 1_000, weight: 55, reps: 10 },
      { sessionId: 's1', startedAt: 1_000, weight: 55, reps: 10 },
      { sessionId: 's1', startedAt: 1_000, weight: 55, reps: 8 },
    ]);

    expect(points).toHaveLength(1);
    expect(points[0].maxWeightSet).toEqual({ weight: 55, reps: 10 });
    expect(points[0].volumeLoad).toBe(55 * 10 + 55 * 10 + 55 * 8);
  });

  it('按训练时间升序，与传入顺序无关', () => {
    const points = buildProgressPoints([...FOUR_SESSIONS].reverse());
    expect(points.map((p) => p.startedAt)).toEqual([1_000, 2_000, 3_000, 4_000]);
  });

  it('最大重量取最重的那一组，不论次数', () => {
    const points = buildProgressPoints([
      { sessionId: 's1', startedAt: 1_000, weight: 60, reps: 10 },
      { sessionId: 's1', startedAt: 1_000, weight: 70, reps: 3 },
      { sessionId: 's1', startedAt: 1_000, weight: 65, reps: 5 },
    ]);

    expect(points[0].maxWeightSet).toEqual({ weight: 70, reps: 3 });
  });

  it('最佳 e1RM 不一定来自最大重量那一组', () => {
    const points = buildProgressPoints([
      { sessionId: 's1', startedAt: 1_000, weight: 60, reps: 10 },
      { sessionId: 's1', startedAt: 1_000, weight: 70, reps: 3 },
    ]);

    // 70×3 更重，但 60×10 换算出来更高（78.51 > 76.42）
    expect(points[0].bestOneRepMaxSet).toEqual({ weight: 60, reps: 10 });
    expect(points[0].bestOneRepMax).toBeCloseTo(78.51, 1);
  });

  it('整场次数都 > 10 时，这一场没有 e1RM —— 是 null，不是 0', () => {
    const points = buildProgressPoints([
      { sessionId: 's1', startedAt: 1_000, weight: 40, reps: 12 },
      { sessionId: 's1', startedAt: 1_000, weight: 40, reps: 15 },
    ]);

    expect(points[0].bestOneRepMax).toBeNull();
    expect(points[0].bestOneRepMaxSet).toBeNull();
    // 但重量和容量照样有 —— 只有 e1RM 会缺点
    // 同重量时取次数多的那一组：40×15 比 40×12 更能说明问题
    expect(points[0].maxWeightSet).toEqual({ weight: 40, reps: 15 });
    expect(points[0].volumeLoad).toBe(40 * 12 + 40 * 15);
  });

  it('次数 = 1 的组也能换算（直接等于实测重量）', () => {
    const points = buildProgressPoints([
      { sessionId: 's1', startedAt: 1_000, weight: 100, reps: 1 },
    ]);

    expect(points[0].bestOneRepMax).toBe(100);
  });

  it('空输入返回空数组，不抛异常', () => {
    expect(buildProgressPoints([])).toEqual([]);
  });
});

describe('toSeries', () => {
  const points = buildProgressPoints([
    ...FOUR_SESSIONS,
    { sessionId: 's5', startedAt: 5_000, weight: 40, reps: 12 },
  ]);

  it('重量与容量两条线没有空点', () => {
    expect(toSeries(points, 'maxWeight')).toEqual([55, 60, 65, 70, 40]);
    expect(toSeries(points, 'volumeLoad')).toEqual([550, 600, 325, 210, 480]);
  });

  it('e1RM 那条线在算不出来的那几次是 null', () => {
    const series = toSeries(points, 'oneRepMax');
    expect(series.slice(0, 4).every((v) => typeof v === 'number')).toBe(true);
    expect(series[4]).toBeNull();
  });
});

describe('summarizeProgress', () => {
  const summary = summarizeProgress(buildProgressPoints(FOUR_SESSIONS));

  it('最大重量取四次里最重的，日期对得上', () => {
    expect(summary.maxWeight).toEqual({ value: 70, at: 4_000 });
  });

  it('最佳 e1RM 来自 60×10 那一场，并带上来源组', () => {
    expect(summary.bestOneRepMax?.at).toBe(2_000);
    expect(summary.bestOneRepMax?.from).toEqual({ weight: 60, reps: 10 });
    expect(summary.bestOneRepMax?.value).toBeCloseTo(78.51, 1);
  });

  it('最高容量是 60×10 那一场（600）', () => {
    expect(summary.maxVolumeLoad).toEqual({ value: 600, at: 2_000 });
  });

  it('没有算不出的场次时计数是 0', () => {
    expect(summary.missingOneRepMaxCount).toBe(0);
  });

  it('数得清有几场算不出 e1RM', () => {
    const withGaps = summarizeProgress(
      buildProgressPoints([
        ...FOUR_SESSIONS,
        { sessionId: 's5', startedAt: 5_000, weight: 40, reps: 12 },
        { sessionId: 's6', startedAt: 6_000, weight: 45, reps: 15 },
      ]),
    );

    expect(withGaps.missingOneRepMaxCount).toBe(2);
    // 缺点的场次不能参与「最好」的评选
    expect(withGaps.bestOneRepMax?.at).toBe(2_000);
  });

  it('空输入时三个最好值都是 null、计数为 0', () => {
    expect(summarizeProgress([])).toEqual({
      maxWeight: null,
      bestOneRepMax: null,
      maxVolumeLoad: null,
      missingOneRepMaxCount: 0,
    });
  });
});
