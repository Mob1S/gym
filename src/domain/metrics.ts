import type { SetLike } from './types';

/**
 * 容量负荷（volume load）= Σ(重量 × 次数)，只累加已完成的组。
 *
 * 注意：文献中 "volume" 一词口径不统一（有的指总次数，有的指组数×次数）。
 * 本 App 一律采用含重量的 volume load 口径，命名上也必须叫 volumeLoad 而不是 volume。
 */
/**
 * @param sets 要累加的组；**未完成的组会被跳过**，仍是 0 贡献
 * @returns 容量负荷（kg）；空数组返回 0
 */
export function totalVolumeLoad(sets: SetLike[]): number {
  return sets.reduce(
    (sum, s) => (s.isCompleted ? sum + s.weight * s.reps : sum),
    0,
  );
}

/**
 * 估算 1RM（e1RM）。
 *
 * 采用三种经典公式的算术平均，以降低单一公式的偏差——同一组数据这三个公式
 * 会给出不同结果，没有任何一个被公认最准。
 *
 * 适用范围：仅当 2 <= reps <= 10 时有效。次数 > 10 时外推严重失真，返回 null，
 * 调用方必须不显示该值。reps === 1 时直接返回实测重量。
 *
 * 界面必须标注「估算 · 仅供参考」。公式一旦确定不得更改，否则进步曲线会断层。
 */
/**
 * @param weight 该组重量（kg）
 * @param reps 该组次数；**只有 2–10 次才有意义**，1 次直接返回实测重量，
 *             > 10 次或 < 1 次返回 null
 * @returns 估算 1RM（kg）；无法换算时返回 null，调用方必须**不显示**该值
 *          （不能当成 0 —— 0 会被读成「练得很差」）
 */
export function estimateOneRepMax(weight: number, reps: number): number | null {
  if (reps < 1) return null;
  if (reps === 1) return weight;
  if (reps > 10) return null;

  const epley = weight * (1 + reps / 30);
  const brzycki = (weight * 36) / (37 - reps);
  const lombardi = weight * Math.pow(reps, 0.1);

  return (epley + brzycki + lombardi) / 3;
}
