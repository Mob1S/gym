import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

/**
 * 常亮的标签。expo-keep-awake 按 tag 计数，激活与释放必须用同一个 tag，
 * 否则释放不掉（或误释放别人的锁）。
 */
const TAG = 'workout';

/**
 * 训练期间保持屏幕常亮——休息计时要求屏幕不灭才准。
 *
 * 失败不影响记录，所以静默吞掉异常：屏幕常亮只是体验优化，
 * 让它把一次「完成这一组」的落盘搞崩，属于本末倒置。
 */
/**
 * @returns 锁已申请（或失败被吞掉）后 resolve。**永不 reject** ——
 *          调用方不需要 try/catch
 */
export async function keepScreenAwake(): Promise<void> {
  try {
    await activateKeepAwakeAsync(TAG);
  } catch {
    // 常亮失败不应影响记录，静默忽略
  }
}

/**
 * 释放常亮锁。`deactivateKeepAwake` 返回 Promise，但释放动作没有后续依赖，
 * 且训练结束时已经落盘完毕，因此不 await —— 这里保持同步签名，
 * 调用方（导航离开、结束训练）不需要为它变成 async。
 */
/**
 * @returns 同步返回，不等释放完成（原因见上）
 */
export function releaseScreenAwake(): void {
  try {
    void deactivateKeepAwake(TAG);
  } catch {
    // 同上
  }
}
