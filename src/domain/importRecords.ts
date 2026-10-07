import type { ImportedWorkout } from './csv';

/**
 * 导入数据的校验与名字归一化。**纯逻辑**：不碰数据库、不读时钟。
 *
 * 校验单独成一层（而不是散在仓储的写入循环里）是为了让「哪种数据不该进库」
 * 在一个地方说清，并且能在毫秒级的单测里全覆盖 —— 落库那个函数的测试要建库。
 */

// 再导出：调用方（界面、仓储）都从 importRecords 拿 ImportedWorkout，
// 不必知道它其实定义在 csv.ts 里。定义留在 csv.ts 是因为「解析出什么形状」
// 由解析器决定，落库只是它的消费者。
export type { ImportedWorkout };

/**
 * 把动作名归一化成用于**匹配**的形式。
 *
 * 必须归一化的理由：别的 App 导出的名字和本机动作库的名字会有细微差别
 * （全角括号、多余空格、大小写）。不归一化就会把「卧推（窄距）」当成一个新动作，
 * 于是同一个动作在库里有两份、进步曲线被切成两段 —— 用户看到的「进步过程」
 * 就此断掉，而这件事极难事后修（要手动合并两条曲线）。
 *
 * 只做四种变换，**不做同义词映射**（「卧推」vs「杠铃卧推」不合并）：
 * 猜错了会把两个不同动作合成一个，比多建一条自定义动作糟得多。
 * 猜不出来的部分交给用户在预览页里看见。
 *
 * @param name 原始动作名
 * @returns 去空白、全角转半角、英文小写之后的名字
 */
export function normalizeExerciseName(name: string): string {
  return name
    .replace(/[\uFF01-\uFF5E]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * 写库前检查一遍，**任何一条不合格就整批拒绝**。
 *
 * 不做「跳过坏的、导入好的」：用户按下「确认导入」时看到的预览是「42 场」，
 * 事后只进去 40 场而没有任何提示，是最糟的结果 —— 他会以为数据丢了。
 *
 * @param workouts 解析或手填出来的训练
 * @returns 通过时 `{ ok: true }`；不合格时给出可直接弹给用户的中文理由
 */
export function validateImportedWorkouts(
  workouts: ImportedWorkout[],
): { ok: true } | { ok: false; reason: string } {
  for (const [index, workout] of workouts.entries()) {
    const label = `第 ${index + 1} 条记录`;
    if (workout.finishedAt < workout.startedAt) {
      return {
        ok: false,
        reason: `${label}的结束时间早于开始时间，这类记录会让历史里的时长变成负数`,
      };
    }
    if (workout.exercises.length === 0) {
      return { ok: false, reason: `${label}一个动作都没有` };
    }
    if (workout.exercises.every((item) => item.sets.length === 0)) {
      return { ok: false, reason: `${label}里没有任何一组，导入后点开是一场空训练` };
    }
  }
  return { ok: true };
}
