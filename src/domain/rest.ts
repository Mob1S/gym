import type { SetEntry } from './types';

/**
 * 超过这个时长的休息，认定为「忘了按开始下一组」，而不是真实休息。
 *
 * 30 分钟是刻意宽松的阈值：力量训练的组间休息极少超过 10 分钟，留三倍余量
 * 是为了绝不误伤一次真实的长时间休息（比如中途接了个电话）。它要挡掉的是
 * 另一种情况 —— 做完一组直接关掉 App 走了，第二天打开看到「组间休息 14:23:00」。
 */
export const STALE_REST_THRESHOLD_MS = 30 * 60 * 1000;

/** 这段休息是否已经跑过头。`restStartedAt` 为 null 表示当前没在休息。 */
/**
 * @param restStartedAt 休息开始的时间戳；null 表示当前没在休息
 * @param now 当前时间戳，由调用方传入（便于测试注入时间）
 * @returns true 表示这段休息已经跑过头，应当被清理而不是记成真实休息
 */
export function isStaleRest(
  restStartedAt: number | null,
  now: number,
): boolean {
  if (restStartedAt === null) return false;
  return now - restStartedAt > STALE_REST_THRESHOLD_MS;
}

/**
 * 从一组记录里找出那段已经跑过头的休息。
 *
 * 返回 `undefined` 表示：没有正在进行的休息，或正在进行的这段还算新鲜，
 * 两种情况调用方都应该什么都不做。
 */
/**
 * @param sets 某个动作下的全部组
 * @param now 当前时间戳
 * @returns 那一组已经跑过头的记录；`undefined` 表示没有正在进行的休息、
 *          或进行中的这段还算新鲜 —— 两种情况调用方都该什么都不做
 */
export function findStaleRest(
  sets: SetEntry[],
  now: number,
): SetEntry | undefined {
  return sets.find((s) => s.isCompleted && isStaleRest(s.restStartedAt, now));
}
