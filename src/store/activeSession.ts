import { create } from 'zustand';

import type { SqlExecutor } from '../db/types';
import type { SessionExercise, SetEntry, WorkoutSession } from '../domain/types';
import { getExercise, listExercises } from '../repositories/exerciseRepo';
import {
  addExerciseToSession,
  createSession,
  finishSession,
  getActiveSession,
  getSession,
  listSessionExercises,
} from '../repositories/sessionRepo';
import {
  addSet,
  completeSet,
  endRest,
  getLastPerformance,
  listSets,
  startRest,
  updateSetValues,
} from '../repositories/setRepo';

const DEFAULT_WEIGHT_KG = 20;
const DEFAULT_REPS = 8;

export interface ActiveExercise {
  sessionExercise: SessionExercise;
  exerciseName: string;
  sets: SetEntry[];
}

interface ActiveSessionState {
  loading: boolean;
  session: WorkoutSession | null;
  exercises: ActiveExercise[];
  currentIndex: number;

  /** 载入未结束的训练；没有就返回 false */
  resume: (exec: SqlExecutor) => Promise<boolean>;
  /** 开一场新训练，并自动加入第一个动作 */
  startNew: (exec: SqlExecutor, name: string | null) => Promise<void>;
  addExercise: (exec: SqlExecutor, exerciseId: string) => Promise<void>;
  setCurrentIndex: (index: number) => void;
  /** 完成当前组的记录，落盘并立刻开始休息计时 */
  completeCurrentSet: (
    exec: SqlExecutor,
    weight: number,
    reps: number,
  ) => Promise<void>;
  /** 结束休息，写入 rest_seconds，显示下一组 */
  beginNextSet: (exec: SqlExecutor) => Promise<void>;
  endWorkout: (exec: SqlExecutor) => Promise<void>;
  reset: () => void;
}

/**
 * 把一场训练的动作与组全部读出来。
 *
 * 注意 `listSets` 收的是 `session_exercise.id`，不是 `exercise.id` —— 这两个
 * 都是字符串 id，写错了 tsc 不会报错，但会一组都读不出来。
 */
async function loadExercises(
  exec: SqlExecutor,
  sessionId: string,
): Promise<ActiveExercise[]> {
  const sessionExercises = await listSessionExercises(exec, sessionId);
  const result: ActiveExercise[] = [];
  for (const se of sessionExercises) {
    const exercise = await getExercise(exec, se.exerciseId);
    const sets = await listSets(exec, se.id);
    result.push({
      sessionExercise: se,
      exerciseName: exercise?.name ?? '未知动作',
      sets,
    });
  }
  return result;
}

/** 找出当前正在休息的那一组（已开始休息、还没结束） */
function findResting(sets: SetEntry[]): SetEntry | undefined {
  return sets.find((s) => s.isCompleted && s.restStartedAt !== null);
}

export const useActiveSession = create<ActiveSessionState>((set, get) => ({
  loading: false,
  session: null,
  exercises: [],
  currentIndex: 0,

  resume: async (exec) => {
    set({ loading: true });
    try {
      const session = await getActiveSession(exec);
      if (!session) return false;
      const exercises = await loadExercises(exec, session.id);
      set({ session, exercises, currentIndex: 0, loading: false });
      return true;
    } finally {
      set({ loading: false });
    }
  },

  startNew: async (exec, name) => {
    const session = await createSession(exec, name);

    // 默认挑一个还没被用过的动作，省得用户第一屏面对空列表。
    // 预置库里一定有「深蹲」，但用户可能先建了自定义动作、或者把深蹲归档了，
    // 所以退回第一个可用动作。
    const all = await listExercises(exec);
    const first = all.find((e) => e.name === '深蹲') ?? all[0];

    if (first) {
      const sessionExercise = await addExerciseToSession(exec, session.id, first.id);
      // 上一次练这个动作的重量/次数，作为这一组的默认值
      const last = await getLastPerformance(exec, first.id, session.id);
      const template = last[0];
      await addSet(
        exec,
        sessionExercise.id,
        template?.weight ?? DEFAULT_WEIGHT_KG,
        template?.reps ?? DEFAULT_REPS,
      );
    }

    const exercises = await loadExercises(exec, session.id);
    set({ session, exercises, currentIndex: 0, loading: false });
  },

  addExercise: async (exec, exerciseId) => {
    const { session } = get();
    if (!session) return;

    const se = await addExerciseToSession(exec, session.id, exerciseId);
    const last = await getLastPerformance(exec, exerciseId, session.id);
    const template = last[0];
    await addSet(
      exec,
      se.id,
      template?.weight ?? DEFAULT_WEIGHT_KG,
      template?.reps ?? DEFAULT_REPS,
    );

    const exercises = await loadExercises(exec, session.id);
    set({ exercises, currentIndex: exercises.length - 1 });
  },

  setCurrentIndex: (index) => set({ currentIndex: index }),

  completeCurrentSet: async (exec, weight, reps) => {
    const { session, exercises, currentIndex } = get();
    if (!session) return;

    const current = exercises[currentIndex];
    if (!current) return;

    const pending = current.sets.find((s) => !s.isCompleted);
    if (!pending) return;

    const now = Date.now();

    // 顺序不能反：先把用户填的数值写进去，再标记完成。
    // 反过来一旦中途失败，就会留下「已完成但数值是旧的」的记录 ——
    // 而全局约束要求每完成一组立刻落盘，用户看到的就是最终记录。
    await updateSetValues(exec, pending.id, weight, reps);
    await completeSet(exec, pending.id, now);
    await startRest(exec, pending.id, now);

    // 预先建好下一组，这样休息结束后立刻有东西可填
    await addSet(exec, current.sessionExercise.id, weight, reps);

    const updated = await listSets(exec, current.sessionExercise.id);
    const nextExercises = [...exercises];
    nextExercises[currentIndex] = { ...current, sets: updated };
    set({ exercises: nextExercises });
  },

  beginNextSet: async (exec) => {
    const { exercises, currentIndex } = get();
    const current = exercises[currentIndex];
    if (!current) return;

    const resting = findResting(current.sets);
    if (resting) {
      await endRest(exec, resting.id, Date.now());
    }

    const updated = await listSets(exec, current.sessionExercise.id);
    const nextExercises = [...exercises];
    nextExercises[currentIndex] = { ...current, sets: updated };
    set({ exercises: nextExercises });
  },

  endWorkout: async (exec) => {
    const { session, exercises, currentIndex } = get();
    if (!session) return;

    // 收尾：如果正处在休息中，先把这段休息结掉，
    // 否则这一组的 rest_seconds 永远是 NULL，总结页算不出平均休息。
    const current = exercises[currentIndex];
    const resting = current ? findResting(current.sets) : undefined;
    if (resting) {
      await endRest(exec, resting.id, Date.now());
    }

    await finishSession(exec, session.id, Date.now());

    // 收尾时把数据重新加载一遍，保证总结页看到的是落盘后的状态
    const reloaded = await loadExercises(exec, session.id);
    const fresh = await getSession(exec, session.id);
    set({ session: fresh, exercises: reloaded });
  },

  reset: () => set({ session: null, exercises: [], currentIndex: 0 }),
}));
