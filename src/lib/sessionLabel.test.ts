import { describeExercises, type ExerciseProgress } from './sessionLabel';

/** `ex('深蹲', 2)` = 深蹲做了 2 组，还有一组待完成 */
function ex(name: string, completed: number): ExerciseProgress {
  return {
    exerciseName: name,
    sets: [
      ...Array.from({ length: completed }, () => ({ isCompleted: true })),
      { isCompleted: false },
    ],
  };
}

describe('describeExercises', () => {
  it('多个动作时写「第一个 等 N 个动作」', () => {
    expect(describeExercises([ex('深蹲', 2), ex('卧推', 1), ex('硬拉', 0)])).toBe(
      '深蹲 等 3 个动作 · 已记 3 组',
    );
  });

  it('只有一个动作时不写「等 1 个动作」', () => {
    expect(describeExercises([ex('深蹲', 3)])).toBe('深蹲 · 已记 3 组');
  });

  it('一组都没记时也如实说，不隐藏', () => {
    expect(describeExercises([ex('深蹲', 0)])).toBe('深蹲 · 已记 0 组');
  });

  it('一个动作都没有时说「还没有动作」', () => {
    expect(describeExercises([])).toBe('还没有动作');
  });
});
