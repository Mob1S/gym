import { estimateOneRepMax, totalVolumeLoad } from './metrics';

/**
 * 输入形状。写成结构化的最小形状，是为了让 domain **不反过来依赖 repositories** ——
 * 仓储层的 `CompletedSetPoint` 天然满足它。
 */
export interface SetPointInput {
  /** 这一组属于哪一场训练 —— 同一个 id 的组会被合并成曲线上的同一个点 */
  sessionId: string;
  /** 该场训练的开始时间（毫秒时间戳），折算后用作点的 x 轴 */
  startedAt: number;
  /** 该组重量（kg） */
  weight: number;
  /** 该组次数 */
  reps: number;
}

/** 曲线上的一个点：**一场训练 = 一个点** */
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
/**
 * @param rows 某个动作（或全部动作）的**已完成**组；顺序无所谓，函数内部自己
 *             按 `sessionId` 分组，传进来的组必须已经是 filtered 过的
 * @returns 每场训练一个点，按 `startedAt` 升序；没有输入时返回空数组
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
 *
 * @param points `buildProgressPoints` 的输出
 * @param metric 取哪条曲线的值
 * @returns 与 `points` **等长**的数值序列，可能含 `null`
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

/** 一个「历史最好」及其出处。`at` 是该场的开始时间，卡片上据此写日期 */
export interface BestMark<T> {
  /** 历史最好的那个值 */
  value: T;
  /** 出现在哪一场（该场的 `startedAt`） */
  at: number;
}

/** 进步页三张卡头上的数字。每一项都在「一场都没练」时为 null */
export interface ProgressSummary {
  /** 历史最重的一组 */
  maxWeight: BestMark<number> | null;
  /** 历史最好的估算 1RM；`from` 说明这个值来自哪一组（卡片上写「来自 60 kg × 10」） */
  bestOneRepMax:
    | (BestMark<number> & { from: { weight: number; reps: number } })
    | null;
  /** 单场容量负荷的最高值 */
  maxVolumeLoad: BestMark<number> | null;
  /** 有几场训练算不出 e1RM，用来在图下写那句说明 */
  missingOneRepMaxCount: number;
}

/**
 * 三张卡头上的数字。**全部是历史最好，不加时间窗** —— 用户当前数据量还小，
 * 加「最近 90 天」只会让他以为自己退步了。
 */
/**
 * @param points `buildProgressPoints` 的输出（顺序不影响结果）
 * @returns 三个「历史最好」+ 算不出 e1RM 的场次；空输入时三个最好值都是 null、
 *          计数为 0，界面据此显示空态
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
