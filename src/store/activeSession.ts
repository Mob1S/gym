import { create } from 'zustand';

import type { SqlExecutor } from '../db/types';
import { findStaleRest } from '../domain/rest';
import type { SessionExercise, SetEntry, WorkoutSession } from '../domain/types';
import { getExercise } from '../repositories/exerciseRepo';
import {
  addExerciseToSession,
  createSession,
  finishSession,
  getActiveSession,
  getSession,
  listSessionExercises,
  listSessions,
} from '../repositories/sessionRepo';
import {
  addSet,
  cancelRest,
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
  /** 开一场新训练，并沿用上一次训练的动作组合（没有历史时为空） */
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
 *
 * 这里还兼任一道闸门：**收拾掉跑过头的休息**。做完一组后如果一直没按
 * 「开始下一组」（直接关掉 App 走了、或者第二天才打开），`rest_started_at`
 * 会一直留着。不处理的话有两个后果 —— 重开 App 会被堵在休息页出不来，以及
 * 这段荒唐的时长会作为 `rest_seconds` 存进库，把休息建议的平均值彻底带偏。
 *
 * 放在这里而不是各个入口分别处理，是因为 `resume` / `startNew` / `addExercise`
 * / `endWorkout` 全都会经过它，一处覆盖全部。
 */
async function loadExercises(
  exec: SqlExecutor,
  sessionId: string,
): Promise<ActiveExercise[]> {
  const sessionExercises = await listSessionExercises(exec, sessionId);
  const now = Date.now();
  const result: ActiveExercise[] = [];
  for (const se of sessionExercises) {
    const exercise = await getExercise(exec, se.exerciseId);
    let sets = await listSets(exec, se.id);

    const stale = findStaleRest(sets, now);
    if (stale) {
      await cancelRest(exec, stale.id);
      sets = await listSets(exec, se.id);
    }

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

/**
 * 往训练里加一个动作，并预建它的第一组。
 *
 * **预建第一组不是可选项。** 记录界面靠「还没完成的那一组」来确定当前该记
 * 哪一组（`pending`），没有这条待完成的记录，`completeCurrentSet` 会直接
 * `return`，用户点「完成这组」会毫无反应 —— 一个静默的假死按钮。
 *
 * 重量/次数沿用上一次练这个动作的第一组，没有历史（新动作、第一次用）时
 * 用默认值兜底。
 *
 * 抽成私有函数是为了让 `startNew`（复制上一次的动作组合）和 `addExercise`
 * （用户手动加动作）共用同一条路径。两处各写一遍必然漂移，而漂移的后果
 * 正是上面那个「按钮没反应」—— 它不会报错，只会让用户以为 App 坏了。
 */
async function addExerciseWithFirstSet(
  exec: SqlExecutor,
  sessionId: string,
  exerciseId: string,
): Promise<SessionExercise> {
  const se = await addExerciseToSession(exec, sessionId, exerciseId);
  const last = await getLastPerformance(exec, exerciseId, sessionId);
  const template = last[0];
  await addSet(
    exec,
    se.id,
    template?.weight ?? DEFAULT_WEIGHT_KG,
    template?.reps ?? DEFAULT_REPS,
  );
  return se;
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

    // 沿用上一次训练的动作组合，而不是每次都替用户挑一个动作。
    //
    // 原来的实现写死了「优先深蹲」，那是为了别让用户第一屏面对空列表偷的懒，
    // 但它等于假设每个人都从深蹲开始 —— 健身房里绝大多数人按固定套路练
    // （推日/拉日/腿日），每次从零挑动作是纯粹的浪费。Strong / Hevy 这类
    // App 都是直接复制上一次的组合。
    //
    // `listSessions` 只返回**已结束**的训练，所以这里天然不会复制到一场
    // 还在进行中的训练。没有历史（第一次用）时就是一场空训练，由界面上的
    // 「添加动作」引导用户挑第一个动作。
    const previous = await listSessions(exec, 1);
    const previousExercises = previous[0]
      ? await listSessionExercises(exec, previous[0].id)
      : [];

    for (const pe of previousExercises) {
      await addExerciseWithFirstSet(exec, session.id, pe.exerciseId);
    }

    const exercises = await loadExercises(exec, session.id);
    set({ session, exercises, currentIndex: 0, loading: false });
  },

  addExercise: async (exec, exerciseId) => {
    const { session } = get();
    if (!session) return;

    await addExerciseWithFirstSet(exec, session.id, exerciseId);

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
