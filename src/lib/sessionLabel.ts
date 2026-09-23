/**
 * 描述一场进行中的训练练到哪了：`深蹲 等 3 个动作 · 已记 12 组`。
 *
 * 主页按钮和「上一场训练还没结束」的询问弹窗共用它。抽出来不是为了省几行
 * 代码，而是为了让「这说的是哪一场」只有一个答案 —— 两处各写一遍，改一处
 * 忘一处时用户会看到两句互相矛盾的话，而这个按钮存在的全部意义就是让他
 * 确认「是不是我刚才那场」。
 *
 * 参数写成结构化的最小形状（而不是 import store 的 `ActiveExercise`），
 * 是为了让 lib 不反过来依赖 store —— `ActiveExercise[]` 天然满足这个形状。
 */
/** `describeExercises` 需要的**最小**形状：只需要动作名和每组是否完成 */
export interface ExerciseProgress {
  /** 动作名，用来拼「深蹲 等 3 个动作」里的第一个 */
  exerciseName: string;
  /** 该动作下的组；只读 `isCompleted` 一个字段 */
  sets: { isCompleted: boolean }[];
}

/**
 * @param exercises 这场训练已有的动作（顺序即界面顺序）
 * @returns 形如 `深蹲 等 3 个动作 · 已记 12 组`；**一个动作都没有时返回「还没有动作」**
 */
export function describeExercises(exercises: ExerciseProgress[]): string {
  const completed = exercises.reduce(
    (sum, item) => sum + item.sets.filter((set) => set.isCompleted).length,
    0,
  );

  if (exercises.length === 0) return '还没有动作';

  const first = exercises[0].exerciseName;
  const what =
    exercises.length === 1 ? first : `${first} 等 ${exercises.length} 个动作`;
  return `${what} · 已记 ${completed} 组`;
}
