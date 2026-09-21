import { estimateOneRepMax, totalVolumeLoad } from './metrics';

/**
 * 输入形状。写成结构化的最小形状，是为了让 domain **不反过来依赖 repositories** ——
 * 仓储层的 `CompletedSetPoint` 天然满足它。
 */
export interface SetPointInput {
  sessionId: string;
  startedAt: number;
  weight: number;
  reps: number;
}

export interface ProgressPoint {
  sessionId: string;
  startedAt: number;
  /** 该场最重的那一组（不论次数，并列取次数多的）。列表行的「65 kg × 5」和重量曲线都用它 */
  maxWeightSet: { weight: number; reps: number };
  volumeLoad: number;
  /** null = 这一场没有可用于换算的组（次数全 > 10） */
  bestOneRepMax: number | null;
  /** 上面那个值来自哪一组，用来在卡上写「来自 60 kg × 10」 */
  bestOneRepMaxSet: { weight: number; reps: number } | null;
}

/**
 * 把某个动作的原始组折算成曲线上的点：**一次训练 = 一个点**。
 *
 * 真实数据里每一组的次数都不一样（55×10 / 60×10 / 65×5 / 70×3），所以每组各算
 * 各的、再取最好的一个当作这一场的点。不按组画点 —— 那样一天之内会来回锯齿，
 * 看不出「进步」，而「进步」正是这一页存在的理由。
 *
 * e1RM 一律调用 `metrics.ts` 的 `estimateOneRepMax`，**公式不在这里重写**：
 * §5.4 规定公式一旦确定不得更改，代码上就落实成「只能有一份实现」。
 */
export function buildProgressPoints(rows: SetPointInput[]): ProgressPoint[] {
  const bySession = new Map<string, SetPointInput[]>();
  for (const row of rows) {
    const bucket = bySession.get(row.sessionId);
    if (bucket) bucket.push(row);
    else bySession.set(row.sessionId, [row]);
  }

  const points: ProgressPoint[] = [];

  for (const [sessionId, sets] of bySession) {
    let maxWeightSet = sets[0];
    let bestOneRepMax: number | null = null;
    let bestOneRepMaxSet: { weight: number; reps: number } | null = null;

    for (const set of sets) {
      // 并列时取次数多的那一组：同样重量多做一次更能说明问题
      if (
        set.weight > maxWeightSet.weight ||
        (set.weight === maxWeightSet.weight && set.reps > maxWeightSet.reps)
      ) {
        maxWeightSet = set;
      }

      const estimate = estimateOneRepMax(set.weight, set.reps);
      if (
        estimate !== null &&
        (bestOneRepMax === null || estimate > bestOneRepMax)
      ) {
        bestOneRepMax = estimate;
        bestOneRepMaxSet = { weight: set.weight, reps: set.reps };
      }
    }

    points.push({
      sessionId,
      startedAt: sets[0].startedAt,
      maxWeightSet: { weight: maxWeightSet.weight, reps: maxWeightSet.reps },
      // 传进来的一律是已完成组，所以补上 isCompleted: true —— 只为了让
      // 容量的公式继续只有 `totalVolumeLoad` 那一份实现。
      volumeLoad: totalVolumeLoad(
        sets.map((set) => ({
          weight: set.weight,
          reps: set.reps,
          isCompleted: true,
        })),
      ),
      bestOneRepMax,
      bestOneRepMaxSet,
    });
  }

  return points.sort((a, b) => a.startedAt - b.startedAt);
}

export type ProgressMetric = 'maxWeight' | 'volumeLoad' | 'oneRepMax';

/**
 * 折线图要的裸数值序列。
 *
 * e1RM 那条线上「整场次数都 > 10」的那几次是 `null` —— 图上不画点、线直接连过去。
 * 绝不能 substitute 成 0：0 是「练得很差」，而事实是「这一场不适合换算」。
 */
export function toSeries(
  points: ProgressPoint[],
  metric: ProgressMetric,
): (number | null)[] {
  return points.map((point) => {
    if (metric === 'oneRepMax') return point.bestOneRepMax;
    if (metric === 'maxWeight') return point.maxWeightSet.weight;
    return point.volumeLoad;
  });
}

export interface BestMark<T> {
  value: T;
  at: number;
}

export interface ProgressSummary {
  maxWeight: BestMark<number> | null;
  bestOneRepMax:
    | (BestMark<number> & { from: { weight: number; reps: number } })
    | null;
  maxVolumeLoad: BestMark<number> | null;
  /** 有几场训练算不出 e1RM，用来在图下写那句说明 */
  missingOneRepMaxCount: number;
}

/**
 * 三张卡头上的数字。**全部是历史最好，不加时间窗** —— 用户当前数据量还小，
 * 加「最近 90 天」只会让他以为自己退步了。
 */
export function summarizeProgress(points: ProgressPoint[]): ProgressSummary {
  let maxWeight: BestMark<number> | null = null;
  let maxVolumeLoad: BestMark<number> | null = null;
  let bestOneRepMax: ProgressSummary['bestOneRepMax'] = null;
  let missingOneRepMaxCount = 0;

  for (const point of points) {
    if (maxWeight === null || point.maxWeightSet.weight > maxWeight.value) {
      maxWeight = { value: point.maxWeightSet.weight, at: point.startedAt };
    }

    if (maxVolumeLoad === null || point.volumeLoad > maxVolumeLoad.value) {
      maxVolumeLoad = { value: point.volumeLoad, at: point.startedAt };
    }

    if (point.bestOneRepMax === null || point.bestOneRepMaxSet === null) {
      missingOneRepMaxCount += 1;
      continue;
    }

    if (bestOneRepMax === null || point.bestOneRepMax > bestOneRepMax.value) {
      bestOneRepMax = {
        value: point.bestOneRepMax,
        at: point.startedAt,
        from: point.bestOneRepMaxSet,
      };
    }
  }

  return { maxWeight, bestOneRepMax, maxVolumeLoad, missingOneRepMaxCount };
}
