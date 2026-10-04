import type { SqlExecutor } from './types';

/**
 * 网页预览专用的内存执行器。
 *
 * ## 这是什么，以及为什么需要它
 *
 * `expo-sqlite` 的 web 实现会 `new Worker(new URL('./worker', ...))`，而 Metro 的
 * 静态 web 打包器对 worker 分块直接断言失败
 * （`@expo/metro-config/build/serializer/serializeChunks.js`：「Workers require
 * standalone bundles even when ordinary chunk splitting is disabled」，
 * 没有任何开关能绕开）。所以 web 端**根本没法加载 expo-sqlite**。
 *
 * 于是 web 用这一份：把四张表放在内存数组里，再按 SQL 的形态分发。
 *
 * ## 它刻意不是什么
 *
 * 它**不是 SQL 引擎**。它按语句的形态（操作类型 + 表名 + 特征子串）分发到对应的
 * 分支，只覆盖这个 App 实际会发的那十几条查询。因此：
 *
 * - 只有 `SqlExecutor` 的调用方（`src/repositories/`）能用它，且只有写死的那些语句能用；
 * - **绝不能**把它当成生产实现 —— 真机走的是 `expo-sqlite` 那条路；
 * - 它只在 `database.web.tsx` 里被引用，而那个文件只在 web 平台被打包。
 *
 * 这么做的收益是：不必为一个预览引入 SQLite 的 WASM 依赖，也就避开了
 * 「网页预览能不能跑」受制于网络能否装包。
 */

/** 一行。列名即键，值一律是 SQLite 认的那几种标量 */
type Row = Record<string, string | number | null>;

/** 四张表 + 各自的插入顺序（对应 SQLite 的 rowid） */
interface Store {
  exercise: Row[];
  session: Row[];
  session_exercise: Row[];
  set_entry: Row[];
}

/** 一天、一小时、一分钟的毫秒数，造演示数据时用 */
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * 演示数据里用到的动作。`id` 固定写死，好让下面的训练数据直接引用它们。
 *
 * 肌群用 App 预设的那六个（见 `exerciseRepo` 的 `MUSCLE_GROUP_ORDER`），
 * 这样动作选择弹层的分组顺序和真机一致。
 */
const DEMO_EXERCISES: {
  id: string;
  name: string;
  muscleGroup: string;
  equipment: string;
}[] = [
  { id: 'ex-squat', name: '杠铃深蹲', muscleGroup: '腿', equipment: '杠铃' },
  { id: 'ex-legpress', name: '腿举', muscleGroup: '腿', equipment: '器械' },
  { id: 'ex-rdl', name: '罗马尼亚硬拉', muscleGroup: '腿', equipment: '杠铃' },
  { id: 'ex-bench', name: '杠铃卧推', muscleGroup: '胸', equipment: '杠铃' },
  { id: 'ex-incline', name: '上斜哑铃卧推', muscleGroup: '胸', equipment: '哑铃' },
  { id: 'ex-row', name: '杠铃划船', muscleGroup: '背', equipment: '杠铃' },
  { id: 'ex-pulldown', name: '高位下拉', muscleGroup: '背', equipment: '器械' },
  { id: 'ex-ohp', name: '站姿推举', muscleGroup: '肩', equipment: '杠铃' },
  { id: 'ex-curl', name: '哑铃弯举', muscleGroup: '手臂', equipment: '哑铃' },
  { id: 'ex-pushdown', name: '绳索下压', muscleGroup: '手臂', equipment: '绳索' },
];

/**
 * 演示训练的动作安排：每次训练练哪几个动作，每个动作的重量与次数。
 *
 * `reps` 数组里**逐组的次数是刻意设计过的**，好让 `restAdvice` 的各种分支都能
 * 在预览里看到：
 * - 全等（如 `[5,5,5,5]`）→ 正反馈分支
 * - 末组掉 1 次 → 「多歇 15 秒」
 * - 末组掉 2 次 → 「多歇 30 秒」
 * - 末组掉 3 次以上 → 提醒延长 + 归因提示
 *
 * 重量逐场递增，这样「进步」页三条曲线都是向上的。
 */
const DEMO_SESSIONS: {
  name: string;
  /** 距今天数，越大越早 */
  daysAgo: number;
  exercises: {
    exerciseId: string;
    weight: number;
    reps: number[];
  }[];
}[] = [
  {
    name: '腿部日',
    daysAgo: 0,
    exercises: [
      { exerciseId: 'ex-squat', weight: 105, reps: [5, 5, 5, 5] },
      { exerciseId: 'ex-legpress', weight: 160, reps: [10, 10, 10, 10] },
      { exerciseId: 'ex-rdl', weight: 90, reps: [8, 8, 7, 5] },
    ],
  },
  {
    name: '推日',
    daysAgo: 2,
    exercises: [
      { exerciseId: 'ex-bench', weight: 80, reps: [6, 6, 5, 4] },
      { exerciseId: 'ex-incline', weight: 30, reps: [10, 10, 9, 8] },
      { exerciseId: 'ex-ohp', weight: 45, reps: [8, 7, 6] },
    ],
  },
  {
    name: '拉日',
    daysAgo: 4,
    exercises: [
      { exerciseId: 'ex-row', weight: 70, reps: [8, 8, 8, 7] },
      { exerciseId: 'ex-pulldown', weight: 65, reps: [10, 10, 10, 10] },
      { exerciseId: 'ex-curl', weight: 15, reps: [12, 12, 11, 9] },
    ],
  },
  {
    name: '腿部日',
    daysAgo: 7,
    exercises: [
      { exerciseId: 'ex-squat', weight: 102.5, reps: [5, 5, 5, 4] },
      { exerciseId: 'ex-legpress', weight: 155, reps: [10, 10, 10, 10] },
    ],
  },
  {
    name: '推日',
    daysAgo: 9,
    exercises: [
      { exerciseId: 'ex-bench', weight: 77.5, reps: [6, 6, 6, 5] },
      { exerciseId: 'ex-ohp', weight: 42.5, reps: [8, 8, 7] },
      { exerciseId: 'ex-pushdown', weight: 30, reps: [12, 12, 12, 10] },
    ],
  },
  {
    name: '拉日',
    daysAgo: 11,
    exercises: [
      { exerciseId: 'ex-row', weight: 67.5, reps: [8, 8, 8, 8] },
      { exerciseId: 'ex-pulldown', weight: 62.5, reps: [10, 10, 10, 9] },
    ],
  },
  {
    name: '腿部日',
    daysAgo: 14,
    exercises: [
      { exerciseId: 'ex-squat', weight: 100, reps: [5, 5, 5, 3] },
      { exerciseId: 'ex-rdl', weight: 85, reps: [8, 8, 7] },
    ],
  },
  {
    name: '推日',
    daysAgo: 16,
    exercises: [
      { exerciseId: 'ex-bench', weight: 75, reps: [6, 6, 5, 5] },
      { exerciseId: 'ex-incline', weight: 27.5, reps: [10, 10, 9] },
    ],
  },
];

/**
 * 造出整套演示数据。
 *
 * 除训练数据外还会造**一场进行中的训练**（`finished_at` 为 NULL、当前动作留一个
 * 未完成的占位组），否则「训练」首页只会显示一个「开始训练」按钮，
 * 看不到「继续训练」那块卡片的改版效果。
 *
 * @returns 四张表的数据，`rowid` 即数组顺序
 */
function buildDemoData(): Store {
  const now = Date.now();
  const store: Store = {
    exercise: [],
    session: [],
    session_exercise: [],
    set_entry: [],
  };

  for (const item of DEMO_EXERCISES) {
    store.exercise.push({
      id: item.id,
      name: item.name,
      muscle_group: item.muscleGroup,
      equipment: item.equipment,
      is_custom: 0,
      is_archived: 0,
      created_at: now - 30 * DAY,
    });
  }

  // 已结束的训练：按 daysAgo 从大到小插入，让 rowid 顺序与时间顺序一致 ——
  // 备份导出和历史列表排序都依赖 rowid 还原「谁先谁后」
  const ordered = [...DEMO_SESSIONS].sort((a, b) => b.daysAgo - a.daysAgo);

  for (const [index, session] of ordered.entries()) {
    const sessionId = `demo-session-${index}`;
    // 晚上 19:30 开练，练 62 分钟
    const startedAt =
      now - session.daysAgo * DAY - HOUR * 3 + MINUTE * 30;
    const finishedAt = startedAt + 62 * MINUTE;

    store.session.push({
      id: sessionId,
      name: session.name,
      started_at: startedAt,
      finished_at: finishedAt,
      note: null,
    });

    session.exercises.forEach((item, exerciseIndex) => {
      const sessionExerciseId = `${sessionId}-se-${exerciseIndex}`;
      store.session_exercise.push({
        id: sessionExerciseId,
        session_id: sessionId,
        exercise_id: item.exerciseId,
        position: exerciseIndex,
        note: null,
      });

      item.reps.forEach((reps, setIndex) => {
        store.set_entry.push({
          id: `${sessionExerciseId}-set-${setIndex}`,
          session_exercise_id: sessionExerciseId,
          position: setIndex,
          weight: item.weight,
          reps,
          is_completed: 1,
          // 组间休息：主要动作歇 150 秒上下，孤立动作短一些。
          // 让平均休息落在 180 秒以内，这样「正反馈」分支才不会被误判成「加重提示」
          rest_seconds: 120 + ((setIndex * 17 + exerciseIndex * 11) % 55),
          rest_started_at: null,
          completed_at: startedAt + (setIndex + 1) * 4 * MINUTE,
        });
      });
    });
  }

  // 一场进行中的训练：让首页的「继续训练」卡片在预览里可见
  const activeStartedAt = now - 35 * MINUTE;
  store.session.push({
    id: 'demo-active',
    name: '腿部日',
    started_at: activeStartedAt,
    finished_at: null,
    note: null,
  });

  const activeExercises = [
    { exerciseId: 'ex-squat', weight: 105, doneReps: [5, 5] },
    { exerciseId: 'ex-legpress', weight: 160, doneReps: [10] },
  ];

  activeExercises.forEach((item, exerciseIndex) => {
    const sessionExerciseId = `demo-active-se-${exerciseIndex}`;
    store.session_exercise.push({
      id: sessionExerciseId,
      session_id: 'demo-active',
      exercise_id: item.exerciseId,
      position: exerciseIndex,
      note: null,
    });

    item.doneReps.forEach((reps, setIndex) => {
      store.set_entry.push({
        id: `${sessionExerciseId}-set-${setIndex}`,
        session_exercise_id: sessionExerciseId,
        position: setIndex,
        weight: item.weight,
        reps,
        is_completed: 1,
        rest_seconds: 135 + setIndex * 10,
        rest_started_at: null,
        completed_at: activeStartedAt + (setIndex + 1) * 5 * MINUTE,
      });
    });

    // 占位组：界面上「第 N 组」和「完成这组」都靠它，没有它记录页会找不到待完成的组
    const position = item.doneReps.length;
    store.set_entry.push({
      id: `${sessionExerciseId}-set-${position}`,
      session_exercise_id: sessionExerciseId,
      position,
      weight: item.weight,
      reps: item.doneReps[item.doneReps.length - 1] ?? 8,
      is_completed: 0,
      rest_seconds: null,
      rest_started_at: null,
      completed_at: null,
    });
  });

  return store;
}

/** 把 `?` 占位符按顺序换成参数值，只用于调试输出 */
function interpolate(sql: string, params: unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const value = params[i++];
    return typeof value === 'string' ? `'${value}'` : String(value);
  });
}

/** 按列名从行里取值，缺失时返回 null */
function value(row: Row, column: string): string | number | null {
  return row[column] ?? null;
}

/** 取数值列，缺失或非数字时返回 0 */
function num(row: Row, column: string): number {
  const v = row[column];
  return typeof v === 'number' ? v : 0;
}

/**
 * 建一个内存版 `SqlExecutor`。
 *
 * @returns 覆盖本 App 全部实际查询的执行器；数据是内置的演示数据
 */
export function createDemoExecutor(): SqlExecutor {
  const store = buildDemoData();

  /**
   * 增删改。只认四种写入语句，其余一律忽略并打一条警告 ——
   * 预览里写失败不该把界面炸掉，但也不能静默到让人以为生效了。
   *
   * @param sql 要执行的语句
   * @param params 占位符参数
   */
  async function run(sql: string, params: unknown[] = []): Promise<void> {
    // 事务与建表/索引语句：内存实现里没有事务概念，直接当成功
    if (/^(BEGIN|COMMIT|ROLLBACK|PRAGMA|CREATE)/i.test(sql.trim())) return;

    if (/^\s*DELETE\s+FROM\s+(\w+)/i.test(sql)) {
      const table = /^\s*DELETE\s+FROM\s+(\w+)/i.exec(sql)![1] as keyof Store;
      if (table in store) store[table] = [];
      return;
    }

    if (/^\s*INSERT\s+INTO\s+(\w+)/i.test(sql)) {
      const table = /^\s*INSERT\s+INTO\s+(\w+)/i.exec(sql)![1] as keyof Store;
      if (!(table in store)) {
        console.warn(`[demo-db] 未知的表：${table}`);
        return;
      }
      // 列名在括号里，取值顺序与 params 一致
      const columns = /\(([^)]+)\)/.exec(sql)?.[1]
        .split(',')
        .map((c) => c.trim()) ?? [];
      const row: Row = {};
      columns.forEach((column, index) => {
        row[column] = (params[index] ?? null) as string | number | null;
      });
      store[table].push(row);
      return;
    }

    if (/^\s*UPDATE\s+(\w+)/i.test(sql)) {
      const table = /^\s*UPDATE\s+(\w+)/i.exec(sql)![1] as keyof Store;
      if (!(table in store)) return;
      const target = store[table];
      const offset = /WHERE\s+id\s*=\s*\?/i.test(sql) ? 1 : 0;

      if (table === 'set_entry' && /rest_seconds\s*=\s*\?/i.test(sql)) {
        // endRest：结束休息，写入秒数并清空开始时间戳
        const [seconds] = params as [number];
        const row = target.find((r) => r.id === params[offset]);
        if (row) {
          row.rest_seconds = seconds;
          row.rest_started_at = null;
        }
        return;
      }
      if (table === 'set_entry' && /is_completed\s*=\s*1/i.test(sql)) {
        const [completedAt] = params as [number];
        const row = target.find((r) => r.id === params[offset]);
        if (row) {
          row.is_completed = 1;
          row.completed_at = completedAt;
        }
        return;
      }
      if (table === 'set_entry' && /SET\s+weight/i.test(sql)) {
        const [weight, reps] = params as [number, number];
        const row = target.find((r) => r.id === params[offset]);
        if (row) {
          row.weight = weight;
          row.reps = reps;
        }
        return;
      }
      if (table === 'set_entry' && /rest_started_at\s*=\s*\?/i.test(sql)) {
        const [at] = params as [number];
        const row = target.find((r) => r.id === params[offset]);
        if (row) row.rest_started_at = at;
        return;
      }
      if (table === 'set_entry' && /rest_started_at\s*=\s*NULL/i.test(sql)) {
        const row = target.find((r) => r.id === params[offset]);
        if (row) row.rest_started_at = null;
        return;
      }
      if (table === 'session' && /finished_at/i.test(sql)) {
        const [finishedAt] = params as [number];
        const row = target.find((r) => r.id === params[offset]);
        if (row) row.finished_at = finishedAt;
        return;
      }
      return;
    }

    console.warn(`[demo-db] 未处理的写入语句：${sql.trim().slice(0, 80)}`);
  }

  /**
   * 查询多行。按语句形态分发到对应的内存查询。
   *
   * @param sql 要执行的 SELECT
   * @param params 占位符参数
   * @returns 匹配的行；没有匹配时是空数组
   */
  async function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const rows = query(sql, params);
    return rows as T[];
  }

  /**
   * 查询单行。复用 `query`，只取第一条。
   *
   * @param sql 要执行的 SELECT
   * @param params 占位符参数
   * @returns 第一行；没有匹配时 null（与 `SqlExecutor` 的约定一致）
   */
  async function first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = query(sql, params);
    return rows.length > 0 ? (rows[0] as T) : null;
  }

  /**
   * 全部查询的分发点。**按从特殊到一般的顺序判断**，否则宽泛的模式会先命中。
   *
   * @param sql 要执行的 SELECT
   * @param params 占位符参数
   * @returns 结果行
   */
  function query(sql: string, params: unknown[]): Row[] {
    const whereId = /WHERE\s+id\s*=\s*\?/i.test(sql);

    // 历史列表：按训练聚合出组数与容量，已结束的在前
    if (/FROM\s+session\s+s/i.test(sql) && /COUNT\(/i.test(sql)) {
      return store.session
        .filter((s) => s.finished_at !== null)
        .map((s) => {
          const exerciseRows = store.session_exercise.filter(
            (se) => se.session_id === s.id,
          );
          const sets = store.set_entry.filter(
            (st) =>
              st.is_completed === 1 &&
              exerciseRows.some((se) => se.id === st.session_exercise_id),
          );
          return {
            id: s.id,
            name: s.name,
            started_at: s.started_at,
            finished_at: s.finished_at,
            set_count: sets.length,
            volume_kg: sets.reduce(
              (sum, st) => sum + num(st, 'weight') * num(st, 'reps'),
              0,
            ),
          };
        })
        .sort((a, b) => num(b, 'started_at') - num(a, 'started_at'));
    }

    // 进行中的训练（finished_at IS NULL）
    if (/FROM\s+session/i.test(sql) && /finished_at\s+IS\s+NULL/i.test(sql)) {
      const active = store.session.filter((s) => s.finished_at === null);
      return active.length > 0 ? [active[active.length - 1]] : [];
    }

    // 已结束的训练列表
    if (
      /FROM\s+session/i.test(sql) &&
      /finished_at\s+IS\s+NOT\s+NULL/i.test(sql) &&
      !whereId
    ) {
      return store.session
        .filter((s) => s.finished_at !== null)
        .sort((a, b) => num(b, 'started_at') - num(a, 'started_at'));
    }

    // 按 id 取一场训练
    if (/FROM\s+session/i.test(sql) && whereId) {
      const found = store.session.find((s) => s.id === params[0]);
      return found ? [found] : [];
    }

    // 「上次练这个动作」的第一步：找出更早的那一场
    if (/FROM\s+session\s+s/i.test(sql) && /JOIN\s+session_exercise/i.test(sql)) {
      const [exerciseId, beforeSessionId] = params as [string, string];
      const candidates = store.session
        .filter((s) => s.id !== beforeSessionId && s.finished_at !== null)
        .filter((s) =>
          store.session_exercise.some(
            (se) => se.session_id === s.id && se.exercise_id === exerciseId,
          ),
        )
        .sort((a, b) => num(b, 'started_at') - num(a, 'started_at'));
      return candidates.length > 0 ? [{ id: candidates[0].id }] : [];
    }

    // 「恢复练到第几个动作」：最近完成的那一组所属的 session_exercise
    if (/FROM\s+set_entry\s+st/i.test(sql) && /completed_at\s+IS\s+NOT\s+NULL/i.test(sql)) {
      const [sessionId] = params as [string];
      const exerciseRows = store.session_exercise.filter(
        (se) => se.session_id === sessionId,
      );
      const done = store.set_entry
        .filter(
          (st) =>
            st.completed_at !== null &&
            exerciseRows.some((se) => se.id === st.session_exercise_id),
        )
        .sort((a, b) => num(b, 'completed_at') - num(a, 'completed_at'));
      if (done.length === 0) return [];
      const owner = exerciseRows.find(
        (se) => se.id === done[0].session_exercise_id,
      );
      return owner ? [{ id: owner.id }] : [];
    }

    // 某个 session_exercise 下的全部组（`listSets`）。
    //
    // **这一条必须排在下面按 `exercise_id` 查的那条前面。** `exercise_id` 是
    // `session_exercise_id` 的子串，反过来放的话 `session_exercise_id = ?`
    // 会先被 `exercise_id = ?` 命中，`listSets` 就永远返回空数组 ——
    // 表现为记录页拿不到组、大数字退回兜底值 20/8。
    if (/FROM\s+set_entry/i.test(sql) && /session_exercise_id\s*=\s*\?/i.test(sql)) {
      return store.set_entry
        .filter((st) => st.session_exercise_id === params[0])
        .sort((a, b) => num(a, 'position') - num(b, 'position'));
    }

    // 动作详情的原始组：跨训练取某个动作所有已完成的组。
    // 用 `se.exercise_id`（带表别名）判定，避免再和上面那条撞车
    if (/FROM\s+set_entry/i.test(sql) && /se\.exercise_id\s*=\s*\?/i.test(sql)) {
      const [exerciseId] = params as [string];
      // 两种情况：指定了某一场（getLastPerformance 的第二步），或全都要（进步页）
      const sessionId = /se2?\.session_id\s*=\s*\?/i.test(sql)
        ? (params[1] as string)
        : null;
      const exerciseRows = store.session_exercise.filter(
        (se) =>
          se.exercise_id === exerciseId &&
          (sessionId === null || se.session_id === sessionId),
      );
      const sessionById = new Map(store.session.map((s) => [s.id, s]));
      return store.set_entry
        .filter(
          (st) =>
            st.is_completed === 1 &&
            exerciseRows.some((se) => se.id === st.session_exercise_id),
        )
        .map((st) => {
          const owner = exerciseRows.find(
            (se) => se.id === st.session_exercise_id,
          )!;
          const session = sessionById.get(owner.session_id as string);
          return {
            ...st,
            session_id: owner.session_id,
            started_at: session?.started_at ?? 0,
          };
        })
        .sort((a, b) => num(a, 'started_at') - num(b, 'started_at'));
    }

    // 按 id 取某一组（endRest 用）
    if (/FROM\s+set_entry/i.test(sql) && whereId) {
      const found = store.set_entry.find((st) => st.id === params[0]);
      return found ? [{ rest_started_at: found.rest_started_at }] : [];
    }

    // 备份导出：整表按插入顺序
    if (/ORDER\s+BY\s+rowid\s+ASC/i.test(sql)) {
      for (const table of [
        'exercise',
        'session',
        'session_exercise',
        'set_entry',
      ] as const) {
        if (new RegExp(`FROM\\s+${table}`, 'i').test(sql)) {
          return [...store[table]];
        }
      }
      return [];
    }

    // 一场训练里的动作
    if (/FROM\s+session_exercise/i.test(sql) && /session_id\s*=\s*\?/i.test(sql)) {
      return store.session_exercise
        .filter((se) => se.session_id === params[0])
        .sort((a, b) => num(a, 'position') - num(b, 'position'));
    }

    // 下一个 position（加动作 / 加组时用）
    if (/MAX\(position\)/i.test(sql)) {
      const table = /FROM\s+(\w+)/i.exec(sql)![1] as keyof Store;
      const column =
        table === 'set_entry' ? 'session_exercise_id' : 'session_id';
      const siblings = store[table].filter((r) => r[column] === params[0]);
      const max = siblings.reduce(
        (acc, r) => Math.max(acc, num(r, 'position')),
        -1,
      );
      return [{ next: max + 1 }];
    }

    // 动作库是否为空（播种前判断）
    if (/COUNT\(\*\)/i.test(sql) && /FROM\s+exercise/i.test(sql)) {
      return [{ count: store.exercise.length }];
    }

    // 动作列表 / 单个动作
    if (/FROM\s+exercise/i.test(sql)) {
      if (whereId) {
        const found = store.exercise.find((e) => e.id === params[0]);
        return found ? [found] : [];
      }
      return store.exercise.filter((e) => value(e, 'is_archived') === 0);
    }

    console.warn(
      `[demo-db] 未处理的查询：${sql.trim().slice(0, 120).replace(/\s+/g, ' ')}`,
    );
    return [];
  }

  return { run, all, first };
}

/**
 * 把一条语句渲染成可读文本，仅在排查预览数据时手动调用。
 *
 * 它不参与任何生产路径，导出只是为了调试时不必再写一遍插值。
 *
 * @param sql 原始语句
 * @param params 占位符参数
 * @returns 参数已代入的语句
 */
export function debugSql(sql: string, params: unknown[]): string {
  return interpolate(sql, params);
}
