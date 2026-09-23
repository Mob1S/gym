import { create } from 'zustand';

import type { SqlExecutor } from '../db/types';
import { findStaleRest } from '../domain/rest';
import type { SessionExercise, SetEntry, WorkoutSession } from '../domain/types';
import { getExercise } from '../repositories/exerciseRepo';
import {
  addExerciseToSession,
  createSession,
  findLastActiveSessionExerciseId,
  finishSession,
  getActiveSession,
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

/**
 * `startNew` 的两种结果。
 *
 * `'conflict'` 表示库里已经有一场进行中的训练，此时**没有**新建任何东西，
 * 那一场已经装进 store —— 界面据此问用户「接着练还是结束它」。
 */
export type StartResult = 'started' | 'conflict';

/**
 * 记录界面上的一个动作卡片：动作本身 + 展示用的名字 + 它的全部组。
 *
 * 名字在这里就查好了（而不是让界面自己去 `getExercise`），因为 `activeSession`
 * 本来就要为「上次练了多少」查一次库，顺手带上不额外花钱。
 */
export interface ActiveExercise {
  /** 这一场里的动作记录 —— **`sets` 里的组引用的是它的 id** */
  sessionExercise: SessionExercise;
  /** 动作名；动作被删/查不到时是「未知动作」 */
  exerciseName: string;
  /** 该动作的全部组，含界面上那条未完成的占位组 */
  sets: SetEntry[];
}

/**
 * 当前训练的全部状态与操作。
 *
 * 这一层是**唯一**允许判定「能不能改这场训练」的地方（每个写操作都先查
 * `finishedAt !== null`）—— 界面只管调，不用自己判断训练是否已结束。
 * 所有写操作都收一个 `exec`，而不是自己去 `useDatabase()`：store 在 React 之外，
 * 拿不到 Context，让调用方传进来是唯一干净的做法。
 */
interface ActiveSessionState {
  /** 正在从库里载入（`resume` 期间为 true），界面据此显示加载态 */
  loading: boolean;
  session: WorkoutSession | null;
  exercises: ActiveExercise[];
  currentIndex: number;

  /** 载入未结束的训练；没有就返回 false */
  resume: (exec: SqlExecutor) => Promise<boolean>;
  /**
   * 开一场新训练，沿用上一次**已结束**训练的动作组合（没有历史时为空）。
   *
   * 库里已经有一场进行中的训练时**不新建**，返回 `'conflict'` 并把那一场装进
   * store 交回界面。这是「同时只可能有一场进行中的训练」这条不变量唯一的守门人 ——
   * 少了它，每点一次「开始新训练」都会多留一条未结束的记录，然后在你结束新的
   * 那场之后冒出来，冒充「上次训练」。
   */
  startNew: (exec: SqlExecutor, name: string | null) => Promise<StartResult>;
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
  /**
   * 结束这场训练：写 `finished_at`，**并立刻清空 store**。
   * 返回被结束的那场的 id（没有当前训练时返回 null）。
   */
  endWorkout: (exec: SqlExecutor) => Promise<string | null>;
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
/**
 * @param exec SQL 执行器
 * @param sessionId 要载入的训练
 * @returns 动作卡片数组，顺序即 `position` 顺序。**训练没有任何动作时返回空数组**
 *          （新训练的正常状态，界面显示「添加动作」引导）
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

/**
 * 找出当前正在休息的那一组（已开始休息、还没结束）。
 *
 * @param sets 某个动作的组
 * @returns 那一组；**没有在休息时返回 undefined**（调用方据此跳过 `endRest`）
 */
function findResting(sets: SetEntry[]): SetEntry | undefined {
  return sets.find((s) => s.isCompleted && s.restStartedAt !== null);
}

/**
 * 算出「上次停在第几个动作」，用来恢复记录界面的位置。
 *
 * 训练里没有「当前动作」这个字段，但推得出来：`completed_at` 最大的那一组
 * 就是用户最后碰过的组，它归属的动作就是当时停下的地方（正在休息时结论相同，
 * `startRest` 就是对刚 `completeSet` 的同一组调用的）。为这件事加一列、做一次
 * 迁移不划算。
 *
 * `Math.max(0, …)` 兜住 `findIndex` 找不到时的 -1：直接拿去当 `currentIndex`
 * 会让记录界面取到 `exercises[-1]`，也就是一片空白。
 */
/**
 * @param exec SQL 执行器
 * @param sessionId 目标训练
 * @param exercises 已经载入的动作数组（用来把 id 换回下标）
 * @returns 该显示第几个动作，从 0 开始；**一组都没完成过时返回 0**（回到第一个动作）
 */
async function resolveCurrentIndex(
  exec: SqlExecutor,
  sessionId: string,
  exercises: ActiveExercise[],
): Promise<number> {
  const lastActiveId = await findLastActiveSessionExerciseId(exec, sessionId);
  if (!lastActiveId) return 0;
  return Math.max(
    0,
    exercises.findIndex((item) => item.sessionExercise.id === lastActiveId),
  );
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
/**
 * @param exec SQL 执行器
 * @param sessionId 目标训练
 * @param exerciseId 要加的动作
 * @returns 新建的 `SessionExercise`（挂在它下面的第一组也已建好）
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

/**
 * 当前训练的 Zustand store。
 *
 * 状态**只存在内存里**，每个写操作都立刻落库，App 重启后靠 `resume` 从库重建。
 * 刻意不做 store 持久化：真相来源只留 SQLite 一份，两处都能改状态必然对不上。
 *
 * 界面用法：`const { session, exercises } = useActiveSession()`。
 * `exec` 不在 store 里 —— 组件从 `useDatabase()` 取，再作为参数传进来。
 */
export const useActiveSession = create<ActiveSessionState>((set, get) => ({
  loading: false,
  session: null,
  exercises: [],
  currentIndex: 0,

  /**
   * @param exec SQL 执行器
   * @returns `true` = 确有未结束的训练、已连同动作与组装进 store；
   *          `false` = 没有，store 保持原样
   */
  resume: async (exec) => {
    set({ loading: true });
    try {
      const session = await getActiveSession(exec);
      if (!session) return false;
      const exercises = await loadExercises(exec, session.id);
      set({
        session,
        exercises,
        currentIndex: await resolveCurrentIndex(exec, session.id, exercises),
        loading: false,
      });
      return true;
    } finally {
      set({ loading: false });
    }
  },

  /**
   * @param exec SQL 执行器
   * @param name 训练名，可为 null
   * @returns `'started'` = 新建成功；`'conflict'` = **一个新记录都没建**，
   *          已有那一场已经装进 store，等界面问用户怎么办
   */
  startNew: async (exec, name) => {
    // 复用 `resume` 而不是另写一次查询：它会把那一场连动作带组一起装进 store，
    // 界面选「接着练」时直接导航过去就有东西可渲染 —— 只返回一个 id 的话，
    // 记录页会因为 store 里没有 exercises 而误判成「这次训练还没有动作」。
    if (await get().resume(exec)) return 'conflict';

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
    return 'started';
  },

  /**
   * @param exec SQL 执行器
   * @param exerciseId 要加进这场训练的动作
   * @returns 加完并刷新 store 后 resolve；`currentIndex` 会跳到新加的那个动作。
   *          训练已结束时**静默返回**，不抛错
   */
  addExercise: async (exec, exerciseId) => {
    const { session } = get();
    // 已结束的训练不能再往里加东西。正常路径下 `endWorkout` 已经清空 store、
    // session 为 null，这里挡的是「有人把一场已结束的训练塞回 store」——
    // 之前的 bug 就是这么让同一场训练被接上第二次、第三次的。
    if (!session || session.finishedAt !== null) return;

    await addExerciseWithFirstSet(exec, session.id, exerciseId);

    const exercises = await loadExercises(exec, session.id);
    set({ exercises, currentIndex: exercises.length - 1 });
  },

  /**
   * 切换当前正在记录的动作（左右滑卡片时调用）。**不写数据库** —— 它是纯界面状态。
   *
   * @param index 目标动作在 `exercises` 里的下标；越界也不会崩，
   *              后续各写操作会因为取不到当前动作而静默返回
   */
  setCurrentIndex: (index) => set({ currentIndex: index }),

  /**
   * 记完当前这一组：写数值 → 标完成 → 起休息计时 → 预建下一组，四步都落盘。
   *
   * @param exec SQL 执行器
   * @param weight 用户此刻填的重量（kg）—— 落盘的就是这个值，不是组里的旧值
   * @param reps 用户此刻填的次数
   * @returns 落盘并刷新 store 后 resolve。**以下情况静默返回**（都不报错）：
   *          训练已结束、`currentIndex` 越界、该动作已无未完成的组（重复点击）
   */
  completeCurrentSet: async (exec, weight, reps) => {
    const { session, exercises, currentIndex } = get();
    if (!session || session.finishedAt !== null) return;

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

  /**
   * 结束休息、进入下一组：写入这段休息的秒数并清掉 `restStartedAt`。
   *
   * @param exec SQL 执行器
   * @returns 结束后 resolve。当前没有在休息时只是刷新一下列表，不写库
   */
  beginNextSet: async (exec) => {
    const { session, exercises, currentIndex } = get();
    if (!session || session.finishedAt !== null) return;
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

  /**
   * 结束并**立刻清空** store（不是等总结页点完成，原因见函数内注释）。
   *
   * @param exec SQL 执行器
   * @returns 被结束的那场训练的 id；**store 里本来就没有训练时返回 null**
   */
  endWorkout: async (exec) => {
    const { session, exercises, currentIndex } = get();
    if (!session) return null;

    // 收尾：如果正处在休息中，先把这段休息结掉，
    // 否则这一组的 rest_seconds 永远是 NULL，总结页算不出平均休息。
    const current = exercises[currentIndex];
    const resting = current ? findResting(current.sets) : undefined;
    if (resting) {
      await endRest(exec, resting.id, Date.now());
    }

    const finishedId = session.id;
    await finishSession(exec, finishedId, Date.now());

    // 结束之后**立刻清空内存**，而不是等用户在总结页点「完成」。
    // 「已经结束但还是当前训练」这个中间态正是主页一直显示「继续上次训练」的
    // 直接原因：用户从总结页按系统返回键离开时永远走不到清空那一步，而主页
    // 只看 store 里有没有 session。
    //
    // 总结页不受影响：它按路由参数从库里读，不依赖 store。
    get().reset();

    return finishedId;
  },

  /**
   * 清空内存里的训练状态。**不碰数据库、不结束训练** ——
   * 调用方要负责先 `finishSession`（`endWorkout` 已经这么做了）。
   *
   * @returns 无
   */
  reset: () => set({ session: null, exercises: [], currentIndex: 0 }),
}));
