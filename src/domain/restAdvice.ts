export type RestFeedbackKind =
  | 'positive'
  | 'add_weight'
  | 'extend_15'
  | 'extend_30'
  | 'extend_30_check_weight';

export interface RestFeedback {
  kind: RestFeedbackKind;
  /** 原始次数数组。界面必须原样展示，让用户能自己核对 */
  reps: number[];
  /** 首组次数 − 末组次数 */
  drop: number;
  /** 平均组后休息秒数；没有休息数据时为 null */
  avgRest: number | null;
  message: string;
}

/** 平均休息超过这个秒数，且次数没掉，就认为「还有余力」 */
const LONG_REST_THRESHOLD_SECONDS = 180;

/** 少于这个组数就不作判断 */
const MIN_SETS = 3;

function averageRest(rests: (number | null)[]): number | null {
  const values = rests.filter((r): r is number => r !== null && r !== undefined);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function formatReps(reps: number[]): string {
  return reps.join(' / ');
}

/**
 * 生成训练后的组间休息提示。
 *
 * 这是**粗略参考**，不是科学结论：只比较本次训练内首组与末组的次数差异，
 * 不跨训练推断、不建统计模型。该领域文献本身对最优休息时长没有共识，
 * 且同一个人不同训练日的反应差异明显。
 *
 * 组数少于 3 时返回 null —— 数据不足时明确沉默，不硬给建议。
 */
export function buildRestFeedback(
  reps: number[],
  rests: (number | null)[],
): RestFeedback | null {
  if (reps.length < MIN_SETS) return null;

  const first = reps[0];
  const last = reps[reps.length - 1];
  const drop = first - last;
  const avgRest = averageRest(rests);
  const list = formatReps(reps);
  const restText = avgRest === null ? null : Math.round(avgRest);

  if (drop <= 0) {
    if (restText !== null && restText > LONG_REST_THRESHOLD_SECONDS) {
      const minutes = Math.floor(restText / 60);
      const seconds = restText % 60;
      return {
        kind: 'add_weight',
        reps,
        drop,
        avgRest,
        message: `${list} 全程稳定，平均歇了 ${minutes} 分 ${seconds} 秒 —— 还有余力，可以考虑加重量`,
      };
    }
    return {
      kind: 'positive',
      reps,
      drop,
      avgRest,
      message: `${list} 全程稳住了，节奏合适`,
    };
  }

  if (drop === 1) {
    return {
      kind: 'extend_15',
      reps,
      drop,
      avgRest,
      message: `末组 ${first} → ${last}，下次这个动作可以多歇 15 秒`,
    };
  }

  if (drop === 2) {
    return {
      kind: 'extend_30',
      reps,
      drop,
      avgRest,
      message: `末组 ${first} → ${last}，下次可以多歇 30 秒`,
    };
  }

  return {
    kind: 'extend_30_check_weight',
    reps,
    drop,
    avgRest,
    message: `末组 ${first} → ${last}，多歇 30 秒试试；如果还是掉，可能是重量偏大`,
  };
}
