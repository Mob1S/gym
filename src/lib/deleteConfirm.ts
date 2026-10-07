import { formatDateFull } from './format';

/**
 * 删除一条训练记录的确认文案。
 *
 * 抽成纯函数是因为列表页和详情页都要弹这一个确认框：两处各写一遍的话，
 * 迟早有一处忘了改，而「这条记录和它的 N 组会一起消失」正是用户唯一能
 * 据以决定按不按「删除」的那句话。
 *
 * 太薄了，不值得为它写测试（断言一段文案的字面值没有价值），只保证全 App
 * 只有这一份实现。
 *
 * @param startedAt 训练开始时间戳
 * @param setCount 这场训练已完成的组数
 * @returns 标题与正文两段文案
 */
export function deleteSessionConfirmText(
  startedAt: number,
  setCount: number,
): { title: string; message: string } {
  return {
    title: `删除 ${formatDateFull(startedAt)} 的训练？`,
    message: `这条记录和它的 ${setCount} 组会一起消失，进步曲线上也会少掉这一个点。删了不能恢复。`,
  };
}
