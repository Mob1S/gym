# 训练生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「继续上次训练」只可能指向一场真正没结束的训练，而没结束的训练只可能来自 App 被误杀。

**Architecture:** 把「当前训练」的生命周期收进 `src/store/activeSession.ts` 一处：库里最多只允许一条 `finished_at IS NULL` 的记录；`startNew` 撞上它就返回 `'conflict'` 交给界面询问；`endWorkout` 是唯一且不可逆的出口（写 `finished_at` 并立刻清空 store）。界面层只做展示与询问，不再各自判断「算不算当前训练」。

**Tech Stack:** React Native 0.86 + Expo Router 57 + zustand 5 + expo-sqlite；测试用 Node 24 内置 `node:sqlite`（`src/db/__tests__/nodeExecutor.ts`）+ Jest。

**设计文档：** `docs/superpowers/specs/2026-09-21-workout-lifecycle-design.md`

## Global Constraints

- 注释与提交信息一律用中文；注释要写**为什么**，不写「做了什么」。
- 界面层（`app/`）永远不直接 import `src/db/`，SQL 只能出现在 `src/repositories/`。
- 每完成一组立刻落盘，这个行为不能改。
- 不做数据库迁移、不改备份格式、不改历史列表的查询。
- 测试与类型检查都必须过：`npx tsc --noEmit` 退出码 0，`npx jest --runInBand` 全绿。
- jest 的 `testMatch` 只收 `src/**/*.test.ts` —— `app/` 下的界面代码没有单元测试，靠 `tsc` + 真机验收（Task 10）。
- 时区：日期格式化一律用本地时区 getter，**不要用 `toLocaleDateString`**（Hermes 上地区行为不一致，项目里已经踩过）。

---

### Task 1: 日期时间格式化抽成唯一实现

现在 `formatDate` 埋在 `app/(tabs)/history.tsx` 里。主页也要显示时间，再抄一份必然漂移，先抽出来。

**Files:**
- Create: `src/lib/format.ts`
- Create: `src/lib/format.test.ts`
- Modify: `app/(tabs)/history.tsx:23-31`（删掉本地的 `WEEKDAY_LABELS` 与 `formatDate`，改成 import）

**Interfaces:**
- Consumes: 无
- Produces: `formatDate(ts: number): string`、`formatTime(ts: number): string`、`formatDateTime(ts: number, now?: number): string`

- [ ] **Step 1: 写失败的测试**

创建 `src/lib/format.test.ts`：

```ts
import { formatDate, formatDateTime, formatTime } from './format';

/** 固定一个「现在」，否则「今天/昨天」的断言会随真实日期漂移 */
const NOW = new Date(2026, 8, 21, 15, 36).getTime(); // 2026-09-21 15:36（月份 0 基）

/** `at(2026, 9, 21, 9, 5)` = 2026-09-21 09:05 本地时间 */
function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe('formatDate', () => {
  it('写成「月日 + 星期」', () => {
    // 2026-09-21 是星期一，往前推 5 天就是星期三
    expect(formatDate(at(2026, 9, 16, 19, 30))).toBe('9月16日 周三');
  });
});

describe('formatTime', () => {
  it('个位数的小时与分钟都要补零', () => {
    expect(formatTime(at(2026, 9, 21, 9, 5))).toBe('09:05');
  });

  it('下午用 24 小时制', () => {
    expect(formatTime(at(2026, 9, 21, 19, 30))).toBe('19:30');
  });
});

describe('formatDateTime', () => {
  it('当天说「今天」', () => {
    expect(formatDateTime(at(2026, 9, 21, 9, 5), NOW)).toBe('今天 09:05');
  });

  it('前一天说「昨天」', () => {
    expect(formatDateTime(at(2026, 9, 20, 23, 50), NOW)).toBe('昨天 23:50');
  });

  it('跨过零点就算「昨天」，而不是按 24 小时算', () => {
    // 差 20 分钟不到一天，但确实是昨天练的
    expect(formatDateTime(at(2026, 9, 20, 23, 59), NOW)).toBe('昨天 23:59');
  });

  it('再早写月日', () => {
    expect(formatDateTime(at(2026, 9, 16, 19, 30), NOW)).toBe('9月16日 19:30');
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx jest src/lib/format.test.ts --runInBand`
Expected: FAIL —— `Cannot find module './format'`

- [ ] **Step 3: 实现**

创建 `src/lib/format.ts`：

```ts
/** 下标即 `getDay()` 的返回值：0 = 周日，1 = 周一 …… 6 = 周六 */
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * `9月16日 周三`
 *
 * 全程用本地时区的 getter，绕开 `toLocaleDateString` 在 Hermes 上的地区差异 ——
 * 同一份代码在不同手机上会排出不同格式，是那种只在别人机器上复现的 bug。
 */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${
    WEEKDAY_LABELS[date.getDay()]
  }`;
}

/** `09:05` —— 必须补零，否则 9 点 5 分会写成 `9:5` */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * 训练是什么时候开始的：`今天 15:20` / `昨天 19:30` / `9月16日 19:30`。
 *
 * 「今天 / 昨天」是为了让用户一眼认出主页那个「继续」按钮说的是哪一场 ——
 * 他打开 App 时心里想的正是「这是刚才那场，还是昨天那场」。
 *
 * `now` 可传入是为了可测：不传就用真实时间。
 */
export function formatDateTime(
  timestamp: number,
  now: number = Date.now(),
): string {
  const days = calendarDaysBetween(now, timestamp);
  if (days === 0) return `今天 ${formatTime(timestamp)}`;
  if (days === 1) return `昨天 ${formatTime(timestamp)}`;
  return `${formatDate(timestamp).split(' ')[0]} ${formatTime(timestamp)}`;
}

/**
 * 按「日历天」算差，而不是按 24 小时。
 *
 * 23:50 练完、次日 00:10 打开 App，两者只差 20 分钟但确实跨了一天，
 * 那时说「昨天」才对。做法是把两个时间戳都抹到当天零点再相减。
 * `Math.round` 兜住夏令时导致的 ±1 小时偏差（中国没有夏令时，但别依赖这个）。
 */
function calendarDaysBetween(now: number, then: number): number {
  const a = new Date(now);
  const b = new Date(then);
  const startOfA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const startOfB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((startOfA - startOfB) / 86400000);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest src/lib/format.test.ts --runInBand`
Expected: PASS，5 个用例全绿

- [ ] **Step 5: history 页改用抽出来的实现**

`app/(tabs)/history.tsx`：删掉文件里的 `WEEKDAY_LABELS`（第 22-23 行）和 `formatDate`（第 25-31 行）两块，并在 import 区加上：

```ts
import { formatDate } from '../../src/lib/format';
```

其余代码一行不改 —— `renderItem` 里那句 `formatDate(item.startedAt)` 继续用。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 退出码 0

- [ ] **Step 7: 提交**

```bash
git add src/lib/format.ts src/lib/format.test.ts "app/(tabs)/history.tsx"
git commit -m "refactor(lib): 日期时间格式化抽成 src/lib/format.ts"
```

---

### Task 2: 仓储层新增「最近有动作的那个动作」查询

恢复「练到第几个动作」需要它。SQL 只能待在仓储层。

**Files:**
- Modify: `src/repositories/sessionRepo.ts`（在 `listSessionExercises` 之后追加）
- Test: `src/repositories/sessionRepo.test.ts`（在 `describe('sessionRepo', …)` 内部追加）

**Interfaces:**
- Consumes: 无
- Produces: `findLastActiveSessionExerciseId(exec: SqlExecutor, sessionId: string): Promise<string | null>` —— 返回 `session_exercise.id`，一组都没完成时返回 `null`

- [ ] **Step 1: 写失败的测试**

在 `src/repositories/sessionRepo.test.ts` 顶部的两个 import 里补上新函数与组相关函数：

```ts
import {
  addExerciseToSession,
  createSession,
  findLastActiveSessionExerciseId,
  finishSession,
  getActiveSession,
  getSession,
  listSessionExercises,
  listSessions,
} from './sessionRepo';
import { createCustomExercise } from './exerciseRepo';
import { addSet, completeSet } from './setRepo';
```

在 `describe('sessionRepo', () => {` 内部、最后一个 `it` 之后追加：

```ts
  it('findLastActiveSessionExerciseId 取最近做过组的那个动作', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日');
    const ex1 = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const ex2 = await createCustomExercise(exec, '腿举', '腿', '器械');
    const se1 = await addExerciseToSession(exec, s.id, ex1.id);
    const se2 = await addExerciseToSession(exec, s.id, ex2.id);

    const first = await addSet(exec, se1.id, 100, 5);
    await completeSet(exec, first.id, 1_000);
    const second = await addSet(exec, se2.id, 50, 10);
    await completeSet(exec, second.id, 2_000);

    expect(await findLastActiveSessionExerciseId(exec, s.id)).toBe(se2.id);
  });

  it('一组都没完成时返回 null', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日');
    const ex1 = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const se1 = await addExerciseToSession(exec, s.id, ex1.id);
    await addSet(exec, se1.id, 100, 5); // 建出来但没完成

    expect(await findLastActiveSessionExerciseId(exec, s.id)).toBeNull();
  });

  it('只看这一场训练：别的训练里做过的组不算数', async () => {
    const exec = await createMigratedExecutor();
    const ex = await createCustomExercise(exec, '深蹲', '腿', '杠铃');

    const other = await createSession(exec, '别的一场');
    const seOther = await addExerciseToSession(exec, other.id, ex.id);
    const done = await addSet(exec, seOther.id, 100, 5);
    await completeSet(exec, done.id, 5_000);

    const s = await createSession(exec, '这一场');
    const se = await addExerciseToSession(exec, s.id, ex.id);
    await addSet(exec, se.id, 100, 5);

    expect(await findLastActiveSessionExerciseId(exec, s.id)).toBeNull();
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx jest src/repositories/sessionRepo.test.ts --runInBand`
Expected: FAIL —— `findLastActiveSessionExerciseId is not a function`

- [ ] **Step 3: 实现**

在 `src/repositories/sessionRepo.ts` 的 `listSessionExercises` 之后追加：

```ts
/**
 * 找出这场训练里**最近有动作的那一组**所属的 `session_exercise`。
 *
 * 用途是恢复「练到第几个动作」：`completed_at` 最大的那一组就是用户最后碰过的
 * 那组，它归属的动作就是当时停下的地方。训练里没有「当前动作」这个字段，
 * 但这件事推得出来，不值得为它加一列。
 *
 * 正在休息时结论相同 —— `startRest` 就是对刚 `completeSet` 的同一组调用的，
 * 所以不需要第二条判定。
 *
 * `st.rowid DESC` 不能省：同一毫秒完成的两组时间戳完全并列，只按 `completed_at`
 * 排序时 SQLite 会退化成按扫描顺序返回，语义就反了（`getLastPerformance` 里
 * 已经踩过同一个坑）。
 */
export async function findLastActiveSessionExerciseId(
  exec: SqlExecutor,
  sessionId: string,
): Promise<string | null> {
  const row = await exec.first<{ id: string }>(
    `SELECT se.id AS id
       FROM set_entry st
       JOIN session_exercise se ON se.id = st.session_exercise_id
      WHERE se.session_id = ?
        AND st.completed_at IS NOT NULL
      ORDER BY st.completed_at DESC, st.rowid DESC
      LIMIT 1`,
    [sessionId],
  );
  return row?.id ?? null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest src/repositories/sessionRepo.test.ts --runInBand`
Expected: PASS，原有 11 条 + 新增 3 条全绿

- [ ] **Step 5: 提交**

```bash
git add src/repositories/sessionRepo.ts src/repositories/sessionRepo.test.ts
git commit -m "feat(repo): 查出训练里最近有动作的那个动作"
```

---

### Task 3: store —— 一条不变量、一个不可逆的结束

这是整个修复的核心。做完这一条，用户报的三个现象就消失了。

**Files:**
- Modify: `src/store/activeSession.ts`
- Test: `src/store/activeSession.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type StartResult = 'started' | 'conflict'`（从 `src/store/activeSession.ts` 导出）
  - `startNew(exec, name): Promise<StartResult>` —— 有进行中的训练时返回 `'conflict'` **且不新建**，并把那一场装进 store
  - `endWorkout(exec): Promise<string | null>` —— 返回被结束那场的 id（没有当前训练时 `null`），**并立刻清空 store**

- [ ] **Step 1: 写失败的测试**

在 `src/store/activeSession.test.ts` 末尾追加（import 区补 `getSession`、`listSessionExercises`、`createCustomExercise` 已经有了，另需 `createSession`、`finishSession` 也已在）：

```ts
/** 库里还剩几条没结束的训练 —— 不变量就是它 ≤ 1 */
async function countUnfinished(exec: SqlExecutor): Promise<number> {
  const row = await exec.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM session WHERE finished_at IS NULL',
  );
  return Number(row?.n ?? 0);
}

async function countAllSessions(exec: SqlExecutor): Promise<number> {
  const row = await exec.first<{ n: number }>('SELECT COUNT(*) AS n FROM session');
  return Number(row?.n ?? 0);
}

describe('进行中的训练最多一条', () => {
  beforeEach(() => {
    useActiveSession.getState().reset();
  });

  it('结束训练之后 store 立刻清空，库里也写上了 finished_at', async () => {
    const exec = await createMigratedExecutor();

    await useActiveSession.getState().startNew(exec, null);
    const id = useActiveSession.getState().session!.id;
    const finishedId = await useActiveSession.getState().endWorkout(exec);

    expect(finishedId).toBe(id);
    // 这一条就是用户报的 bug：结束之后主页还显示「继续上次训练」，
    // 因为内存里那条没清。
    expect(useActiveSession.getState().session).toBeNull();
    expect(await countUnfinished(exec)).toBe(0);
  });

  it('结束之后紧接着开新的一场，不会再撞上冲突', async () => {
    const exec = await createMigratedExecutor();

    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().endWorkout(exec);

    expect(await useActiveSession.getState().startNew(exec, null)).toBe('started');
    expect(await countUnfinished(exec)).toBe(1);
  });

  it('库里有一场进行中的训练时，startNew 返回 conflict 且不新建', async () => {
    const exec = await createMigratedExecutor();
    const running = await createSession(exec, '没结束的训练');

    expect(await useActiveSession.getState().startNew(exec, null)).toBe('conflict');
    expect(await countAllSessions(exec)).toBe(1);
    // 冲突的那一场必须已经装进 store：界面选「接着练」要直接导航过去，
    // 选「结束它」要能对它调 endWorkout。
    expect(useActiveSession.getState().session?.id).toBe(running.id);
  });

  it('连着调两次 startNew，只会留下一条未结束的训练', async () => {
    const exec = await createMigratedExecutor();

    expect(await useActiveSession.getState().startNew(exec, null)).toBe('started');
    expect(await useActiveSession.getState().startNew(exec, null)).toBe('conflict');

    expect(await countUnfinished(exec)).toBe(1);
  });

  it('已结束的训练不会被 resume 接回来', async () => {
    const exec = await createMigratedExecutor();

    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().endWorkout(exec);

    expect(await useActiveSession.getState().resume(exec)).toBe(false);
    expect(useActiveSession.getState().session).toBeNull();
  });

  it('已结束的训练不接受新动作（防御闸门）', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');

    await useActiveSession.getState().startNew(exec, null);
    const id = useActiveSession.getState().session!.id;
    await useActiveSession.getState().endWorkout(exec);

    // 模拟「有人绕过状态机，把一场已结束的训练塞回 store」
    const finished = await getSession(exec, id);
    useActiveSession.setState({ session: finished });
    await useActiveSession.getState().addExercise(exec, squat.id);

    expect(await listSessionExercises(exec, id)).toEqual([]);
  });
});
```

同时**重写**现有的那条用例（`src/store/activeSession.test.ts:179` 起，「还在进行中的训练不算『上一次』，不会被复制」），换成新语义：

```ts
  it('进行中的训练不会被当成「上一次」，startNew 直接交回冲突', async () => {
    const exec = await createMigratedExecutor();
    // 同上：预置库也灌上，这条才同时挡住「从进行中的训练复制」和
    // 「随便挑一个动作塞进去」两种旧行为。
    await seedExercisesIfEmpty(exec);
    const running = await createSession(exec, '没结束的训练');
    const exercise = await createCustomExercise(exec, '硬拉', '背', '杠铃');
    await addExerciseToSession(exec, running.id, exercise.id);

    expect(await useActiveSession.getState().startNew(exec, null)).toBe('conflict');
    // 没有新建任何训练，也就没有「复制了谁」这回事
    expect(useActiveSession.getState().session?.id).toBe(running.id);
  });
```

`getSession` 与 `listSessionExercises` 已经在文件顶部的 import 里；`createCustomExercise`、`seedExercisesIfEmpty` 也已导入，不需要新增 import。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx jest src/store/activeSession.test.ts --runInBand`
Expected: FAIL —— `endWorkout` 之后 `session` 不为 null、`startNew` 返回 `undefined` 而非 `'conflict'`

- [ ] **Step 3: 实现**

`src/store/activeSession.ts` 按下面四处改。

**3a. 顶部加类型（放在 `DEFAULT_REPS` 之后）：**

```ts
/**
 * `startNew` 的两种结果。
 *
 * `'conflict'` 表示库里已经有一场进行中的训练，此时**没有**新建任何东西，
 * 那一场已经装进 store —— 界面据此问用户「接着练还是结束它」。
 */
export type StartResult = 'started' | 'conflict';
```

**3b. 接口声明改两处：**

```ts
  /**
   * 开一场新训练，沿用上一次**已结束**训练的动作组合（没有历史时为空）。
   *
   * 库里已经有一场进行中的训练时**不新建**，返回 `'conflict'` 并把那一场装进
   * store 交回界面。这是「同时只可能有一场进行中的训练」这条不变量唯一的守门人 ——
   * 少了它，每点一次「开始新训练」都会多留一条未结束的记录，然后在你结束新的
   * 那场之后冒出来，冒充「上次训练」。
   */
  startNew: (exec: SqlExecutor, name: string | null) => Promise<StartResult>;
```

```ts
  /**
   * 结束这场训练：写 `finished_at`，**并立刻清空 store**。
   * 返回被结束的那场的 id（没有当前训练时返回 null）。
   */
  endWorkout: (exec: SqlExecutor) => Promise<string | null>;
```

**3c. `startNew` 开头加冲突判定、结尾返回 `'started'`：**

```ts
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
```

**3d. `endWorkout` 结尾清空并返回 id：**

```ts
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
    reset();

    return finishedId;
  },
```

**3e. 三个入口的防御闸门。** `addExercise`、`completeCurrentSet`、`beginNextSet` 的取 state 那一行后面各加一句判断。以 `addExercise` 为例：

```ts
  addExercise: async (exec, exerciseId) => {
    const { session } = get();
    // 已结束的训练不能再往里加东西。正常路径下 `endWorkout` 已经清空 store、
    // session 为 null，这里挡的是「有人把一场已结束的训练塞回 store」——
    // 之前的 bug 就是这么让同一场训练被接上第二次、第三次的。
    if (!session || session.finishedAt !== null) return;
```

`completeCurrentSet` 与 `beginNextSet` 同理，把各自的取 state 那行改成：

```ts
    const { session, exercises, currentIndex } = get();
    if (!session || session.finishedAt !== null) return;
```

（`beginNextSet` 原本没有取 `session`，加上。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest src/store/activeSession.test.ts --runInBand`
Expected: PASS，全部用例绿

- [ ] **Step 5: 跑全量测试确认没有连带打坏别处**

Run: `npx jest --runInBand`
Expected: 全部 suite PASS

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 退出码 0（此时 `app/(tabs)/index.tsx` 里 `startNew` 的返回值还没被使用，属于合法忽略）

- [ ] **Step 7: 提交**

```bash
git add src/store/activeSession.ts src/store/activeSession.test.ts
git commit -m "fix(store): 结束训练立刻清内存，开始新训练不再留僵尸训练"
```

---

### Task 4: store —— resume 恢复练到第几个动作

**Files:**
- Modify: `src/store/activeSession.ts`
- Test: `src/store/activeSession.test.ts`

**Interfaces:**
- Consumes: `findLastActiveSessionExerciseId(exec, sessionId): Promise<string | null>`（Task 2）
- Produces: 无新导出 —— `resume` 的 `currentIndex` 不再恒为 0

- [ ] **Step 1: 写失败的测试**

在 `src/store/activeSession.test.ts` 末尾追加：

```ts
describe('resume 恢复练到第几个动作', () => {
  beforeEach(() => {
    useActiveSession.getState().reset();
  });

  it('停在上次最后碰过的那个动作，而不是永远回到第一个', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const bench = await createCustomExercise(exec, '卧推', '胸', '杠铃');

    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().addExercise(exec, squat.id);
    await useActiveSession.getState().completeCurrentSet(exec, 100, 5);
    await useActiveSession.getState().completeCurrentSet(exec, 100, 5);
    await useActiveSession.getState().addExercise(exec, bench.id);
    await useActiveSession.getState().completeCurrentSet(exec, 60, 8);

    useActiveSession.getState().reset(); // 等价于 App 被杀之后重启
    expect(await useActiveSession.getState().resume(exec)).toBe(true);

    const { exercises, currentIndex } = useActiveSession.getState();
    expect(exercises.map((e) => e.exerciseName)).toEqual(['深蹲', '卧推']);
    // 用户是在练卧推的时候被杀的，回来就该在卧推上
    expect(exercises[currentIndex].exerciseName).toBe('卧推');
  });

  it('一组都没做时回到第一个动作', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');

    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().addExercise(exec, squat.id);

    useActiveSession.getState().reset();
    await useActiveSession.getState().resume(exec);

    expect(useActiveSession.getState().currentIndex).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx jest src/store/activeSession.test.ts --runInBand`
Expected: FAIL —— 第一条断言 `exercises[0].exerciseName` 得到 `'深蹲'`，期望 `'卧推'`

- [ ] **Step 3: 实现**

`src/store/activeSession.ts`。

**3a. import 里加上新查询：**

```ts
import {
  addExerciseToSession,
  createSession,
  findLastActiveSessionExerciseId,
  finishSession,
  getActiveSession,
  getSession,
  listSessionExercises,
  listSessions,
} from '../repositories/sessionRepo';
```

**3b. 在 `findResting` 之后加一个私有函数：**

```ts
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
```

**3c. `resume` 里换掉写死的 0：**

```ts
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
```

注意：`startNew` 末尾仍然是 `currentIndex: 0`（新训练本来就从第一个动作开始），不要动它。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest src/store/activeSession.test.ts --runInBand`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/store/activeSession.ts src/store/activeSession.test.ts
git commit -m "fix(store): resume 回到上次练到的那个动作，不再永远从第一个开始"
```

---

### Task 5: 那一行描述的唯一实现

主页按钮和冲突询问弹窗都要说「这是哪一场」。两处各写一遍必然漂移，抽成一个可测的纯函数。

**Files:**
- Create: `src/lib/sessionLabel.ts`
- Create: `src/lib/sessionLabel.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `describeExercises(exercises: ExerciseProgress[]): string`、`interface ExerciseProgress { exerciseName: string; sets: { isCompleted: boolean }[] }`

- [ ] **Step 1: 写失败的测试**

创建 `src/lib/sessionLabel.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx jest src/lib/sessionLabel.test.ts --runInBand`
Expected: FAIL —— `Cannot find module './sessionLabel'`

- [ ] **Step 3: 实现**

创建 `src/lib/sessionLabel.ts`：

```ts
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
export interface ExerciseProgress {
  exerciseName: string;
  sets: { isCompleted: boolean }[];
}

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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest src/lib/sessionLabel.test.ts --runInBand`
Expected: PASS，4 条全绿

- [ ] **Step 5: 提交**

```bash
git add src/lib/sessionLabel.ts src/lib/sessionLabel.test.ts
git commit -m "feat(lib): 训练进度描述抽成可测的纯函数"
```

---

### Task 6: 主页 —— 只在真没结束时出现，并说清是哪一场

**Files:**
- Modify: `app/(tabs)/index.tsx`（整文件重写）
- 无单元测试（`app/` 不在 jest 的 `testMatch` 里），靠 Step 3 的 `tsc` 与 Task 10 的真机验收

**Interfaces:**
- Consumes: `startNew` 的 `'conflict'` 返回值（Task 3）、`endWorkout`（Task 3）、`formatDateTime`（Task 1）、`describeExercises`（Task 5）
- Produces: 无

- [ ] **Step 1: 重写文件**

把 `app/(tabs)/index.tsx` 整个替换为：

```tsx
import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDateTime } from '../../src/lib/format';
import { keepScreenAwake } from '../../src/lib/keepAwake';
import { describeExercises } from '../../src/lib/sessionLabel';
import { useDatabase } from '../../src/repositories/database';
import { useActiveSession } from '../../src/store/activeSession';

export default function TrainTab() {
  const exec = useDatabase();
  const router = useRouter();
  const { session, exercises, loading, startNew, resume, endWorkout } =
    useActiveSession();

  // 只有「还没结束」的才算当前训练，必须在 finishedAt 上判，而不是「有没有
  // session」—— 后者曾经让一场已经结束、只是还留在内存里的训练也长出一个
  // 「继续上次训练」按钮，点进去还能接着往里记组。
  //
  // 窄化成 `current` 而不是留一个 boolean：`session` 的类型是
  // `WorkoutSession | null`，从 boolean 变量推不出它非空，JSX 里直接写
  // `session.id` 过不了 tsc。
  const current =
    session !== null && session.finishedAt === null ? session : null;

  // App 被强杀或用户切走再回来时，库里可能还留着一条未结束的训练，
  // 进入训练页先把它捡回来，「继续上次训练」按钮才会自动出现。
  useEffect(() => {
    if (!session) {
      void resume(exec);
    }
  }, [exec, resume, session]);

  const openSession = useCallback(
    (id: string) => {
      void keepScreenAwake();
      // 必须用对象形式。expo-router 的 typedRoutes 对动态路由只生成
      // `/session/[id]` 这个字面量，没有 `/session/${string}` 模板，
      // 写成模板字符串过不了 tsc。
      router.push({ pathname: '/session/[id]', params: { id } });
    },
    [router],
  );

  const openCurrent = useCallback(async () => {
    const started = useActiveSession.getState().session;
    if (started) openSession(started.id);
  }, [openSession]);

  const handleStart = useCallback(async () => {
    const result = await startNew(exec, null);

    if (result === 'conflict') {
      // `startNew` 撞上未结束的训练时不新建，而是把那一场装进 store 并返回
      // 'conflict'。这里读的就是它 —— 弹窗里说的和待会儿进去的必须是同一场。
      const { session: blocked, exercises: blockedExercises } =
        useActiveSession.getState();
      if (!blocked) return;
      Alert.alert(
        '上一场训练还没结束',
        `${formatDateTime(blocked.startedAt)} · ${describeExercises(
          blockedExercises,
        )}`,
        [
          {
            text: '接着练',
            style: 'cancel',
            onPress: () => openSession(blocked.id),
          },
          {
            text: '结束它，开始新的',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                await endWorkout(exec);
                await startNew(exec, null);
                await openCurrent();
              })();
            },
          },
        ],
        // 点空白处 / 返回键 = 什么都不做。Android 上一个 Alert 最多三个按钮，
        // 布局固定是 [neutral, negative, positive]，硬塞第三个必然有一个落进
        // 最右那个加粗位置 —— 无论把「接着练」还是「结束它」放那儿都是误导，
        // 所以第三条路交给「不选」。
        { cancelable: true },
      );
      return;
    }

    await openCurrent();
  }, [endWorkout, exec, openCurrent, openSession, startNew]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>训练</Text>

      {current ? (
        <Pressable
          style={styles.primaryButton}
          onPress={() => openSession(current.id)}
        >
          <Text style={styles.primaryButtonText}>
            继续 {formatDateTime(current.startedAt)} 的训练
          </Text>
          <Text style={styles.resumeDetail}>{describeExercises(exercises)}</Text>
        </Pressable>
      ) : null}

      <Pressable
        style={[styles.primaryButton, current ? styles.secondaryButton : null]}
        onPress={handleStart}
        disabled={loading}
      >
        <Text
          style={[
            styles.primaryButtonText,
            current ? styles.secondaryButtonText : null,
          ]}
        >
          {current ? '开始新训练' : '开始训练'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  primaryButton: {
    backgroundColor: '#2b7fff',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 32,
    minWidth: 220,
    alignItems: 'center',
    gap: 4,
  },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  // 「继续」按钮上的第二行：说明这一场练到哪了，用半透明白压在主色上
  resumeDetail: { color: 'rgba(255,255,255,0.85)', fontSize: 13 },
  secondaryButton: { backgroundColor: '#eceef2' },
  secondaryButtonText: { color: '#4b5058' },
});
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 退出码 0

- [ ] **Step 3: 提交**

```bash
git add "app/(tabs)/index.tsx"
git commit -m "fix(home): 继续上次训练只在真没结束时出现，并写明是哪一场"
```

---

### Task 7: 记录页 —— 写保护与两个空态

**Files:**
- Modify: `app/session/[id].tsx`

**Interfaces:**
- Consumes: `endWorkout` 清空 store 的行为（Task 3）
- Produces: 无

- [ ] **Step 1: 加两个本地状态**

在 `app/session/[id].tsx` 里 `const [allExercises, setAllExercises] = useState<Exercise[]>([]);` 之后加：

```tsx
  // 收尾中：`endWorkout` 会立刻清空 store，而 `router.replace` 还在后面。
  // 不挡住这一帧的话，屏幕上会闪过一句「这场训练不存在或已结束」。
  const [finishing, setFinishing] = useState(false);
  // 深链进来时 store 可能是空的，得先知道「加载中」和「确实没有」的区别 ——
  // 只判 `!session` 的话，一个不存在的 id 会让这一屏永远停在「载入中…」。
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing'>(
    'loading',
  );
```

- [ ] **Step 2: 换掉那个捡回 session 的 effect**

把原来的：

```tsx
  useEffect(() => {
    if (!session || session.id !== id) {
      void resume(exec);
    }
  }, [exec, id, resume, session]);
```

换成：

```tsx
  useEffect(() => {
    let cancelled = false;
    if (session && session.id === id) {
      setLoadState('ready');
      return undefined;
    }
    void (async () => {
      const found = await resume(exec);
      if (!cancelled) setLoadState(found ? 'ready' : 'missing');
    })();
    return () => {
      cancelled = true;
    };
  }, [exec, id, resume, session]);
```

- [ ] **Step 3: 换掉那个「载入中…」分支**

把原来的：

```tsx
  if (!session || session.id !== id) {
    return (
      <View style={styles.container}>
        <Text style={styles.hint}>载入中…</Text>
      </View>
    );
  }
```

换成：

```tsx
  if (finishing) {
    // 一帧的白屏，紧接着就是总结页
    return <View style={styles.container} />;
  }

  if (!session || session.id !== id) {
    return (
      <View
        style={[
          styles.container,
          styles.emptyContainer,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 20 },
        ]}
      >
        <Text style={styles.hint}>
          {loadState === 'loading' ? '载入中…' : '这场训练不存在或已结束'}
        </Text>
        {loadState === 'missing' ? (
          <Pressable
            style={styles.completeButton}
            onPress={() => router.replace('/(tabs)')}
          >
            <Text style={styles.completeButtonText}>回主页</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  // 写保护：这场已经结束了，就不该再渲染记录界面。
  // 深链（或从总结页按系统返回键绕回来）能走到这里，而「结束」必须不可逆 ——
  // 之前同一场训练被接上第二次、第三次，靠的就是这里没有这道判断。
  if (session.finishedAt !== null) {
    return (
      <View
        style={[
          styles.container,
          styles.emptyContainer,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 20 },
        ]}
      >
        <Text style={styles.hint}>这场训练已经结束</Text>
        <Pressable
          style={styles.completeButton}
          onPress={() => router.replace('/(tabs)')}
        >
          <Text style={styles.completeButtonText}>回主页</Text>
        </Pressable>
      </View>
    );
  }
```

注意分支顺序必须是：`finishing` → `!session` → `finishedAt !== null` → 原有的 `!current`（「这次训练还没有动作」）。前三段插在原来那个「载入中…」分支的位置上，`!current` 那段保持在它后面不动。

- [ ] **Step 4: `handleFinish` 先挡住重渲染**

把 `handleFinish` 里的 `onPress` 换成：

```tsx
        onPress: async () => {
          // 先挡住重渲染：endWorkout 会清空 store，而导航还在它后面。
          setFinishing(true);
          try {
            await endWorkout(exec);
          } catch (e) {
            // 失败必须让用户知道，否则这一屏会一直停在空白上
            setFinishing(false);
            Alert.alert(
              '没能结束这次训练',
              e instanceof Error ? e.message : String(e),
            );
            return;
          }
          router.replace({ pathname: '/session/summary/[id]', params: { id } });
        },
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 退出码 0

- [ ] **Step 6: 提交**

```bash
git add "app/session/[id].tsx"
git commit -m "fix(session): 已结束的训练不可再记录，空态不再永远转圈"
```

---

### Task 8: 总结页 —— 「完成」不再负责保存

「结束了但没保存」这个中间态就此消失，它正是整个 bug 的来源。

**Files:**
- Modify: `app/session/summary/[id].tsx`

**Interfaces:**
- Consumes: `endWorkout` 已在「结束训练」时落盘（Task 3）
- Produces: 无

- [ ] **Step 1: 换掉 import 与整个 handleSave**

把 import 区里的：

```tsx
import { finishSession } from '../../../src/repositories/sessionRepo';
import { useActiveSession } from '../../../src/store/activeSession';
```

换成：

```tsx
import { finishSession, getSession } from '../../../src/repositories/sessionRepo';
```

（`useActiveSession` 不再需要 —— `endWorkout` 与 `reset` 都不在这里调了。）

把 `const endWorkout = …` 与 `const reset = …` 两行删掉，`handleSave` 换成：

```tsx
  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // 落盘已经在「结束训练」那一下完成了，这里只做兜底：强杀后经深链直接进
      // 这一屏时 store 是空的，那一下没跑过，这一场的 finished_at 还是 NULL。
      //
      // **只在这场确实没结束时才写。** 无条件覆盖会把已经写好的结束时间往后推，
      // 总结页的时长跟着一起变长 —— 那是用户能看见的数字。
      if (id) {
        const stored = await getSession(exec, id);
        if (stored && stored.finishedAt === null) {
          await finishSession(exec, id, Date.now());
        }
      }

      releaseScreenAwake();
      router.replace('/(tabs)');
    } catch (e) {
      // 保存失败必须让用户知道，否则他会以为这次训练已经存好了。
      Alert.alert('没能保存这次训练', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
```

- [ ] **Step 2: 按钮文案改成「完成」**

```tsx
        <Text style={styles.saveButtonText}>完成</Text>
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 退出码 0

- [ ] **Step 4: 全量测试 + 类型检查**

Run: `npx jest --runInBand` 与 `npx tsc --noEmit`
Expected: 全部 PASS，tsc 退出码 0

- [ ] **Step 5: 提交**

```bash
git add "app/session/summary/[id].tsx"
git commit -m "fix(summary): 结束时已落盘，总结页的按钮不再负责保存"
```

---

### Task 9: 真机验收与重新打包

代码到这一步就完整了，但**用户手机上装的是 2026-09-16 那一版**，不重新打包他看不到任何变化。

**Files:**
- Modify: `docs/superpowers/plans/m2-acceptance-checklist.md`（追加本次验收结果）

**Interfaces:**
- Consumes: Task 1-8 的全部改动
- Produces: 一份装到手机上的新 APK

- [ ] **Step 1: 打包环境**

```powershell
. .superpowers\build-env.ps1
$env:EXPO_TOKEN = '<在 expo.dev 生成的 Access Token>'
Set-Location C:\ccproject\gym
```

- [ ] **Step 2: 云构建（约 20 分钟）**

```powershell
eas build --platform android --profile preview --non-interactive
```

查状态（不需要 eas-cli 起子进程）：

```powershell
node --use-system-ca .superpowers\eas-status.cjs <build-id>
```

- [ ] **Step 3: 装到手机**

```powershell
adb install -r .superpowers\gym-tracker-preview.apk
adb shell am start -n com.ccproject.gymtracker/.MainActivity
```

- [ ] **Step 4: 逐条走验收清单**

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 开始训练 → 做两组 → 从最近任务里划掉 App（**不点结束**）→ 重开 | 主页显示「继续 今天 HH:MM 的训练 / 深蹲 等 N 个动作 · 已记 2 组」，点进去回到深蹲、第 3 组 |
| 2 | 结束训练 → 在总结页按系统返回键回主页 | 主页**没有**「继续」按钮 |
| 3 | 做一场 → 结束 → 完成 → 主页点「开始训练」 | 直接开新的，不弹询问；旧的那场不再出现 |
| 4 | 造一场未结束的（开始后划掉）→ 重开 → 点「开始新训练」 | 弹「上一场训练还没结束」；选「接着练」回到那场；再试一次选「结束它，开始新的」，旧的那场进历史，新这场干净 |
| 5 | 看历史列表 | 进行中的训练不出现 |
| 6 | 深链 `adb shell am start -a android.intent.action.VIEW -d "gymtracker://session/<已结束的 id>"` | 显示「这场训练已经结束」，不出现记录界面 |

- [ ] **Step 5: 把结果追加到验收清单**

在 `docs/superpowers/plans/m2-acceptance-checklist.md` 末尾追加一节，格式与文件里既有的 M3 那一节一致：日期、构建来源、逐条打勾、真机型号、以及任何没通过的原因。

- [ ] **Step 6: 提交**

```bash
git add docs/superpowers/plans/m2-acceptance-checklist.md
git commit -m "docs: 训练生命周期修复的真机验收结果"
```

---

## 实施记录（2026-09-21）

9 个 Task 由独立 subagent 逐个执行，每个 Task 完成后由主 agent 复核（读 diff + `npx tsc --noEmit` + 全量 `npx jest --runInBand`）再放行下一个。

| Task | 提交 | 内容 |
|---|---|---|
| 1 | `73f12dc` | 日期时间格式化抽成 `src/lib/format.ts` |
| 2 | `f13cb9a` | `findLastActiveSessionExerciseId` |
| 3 | `5484f7c` | 不变量：`startNew` 冲突、`endWorkout` 清内存、三处防御闸门 |
| 4 | `9445763` | `resume` 恢复练到第几个动作 |
| 5 | `25e7d88` | `describeExercises` |
| 6 + 8 | `dbb065f` | 主页 + 总结页（见下面的并发事故） |
| 7 | `56c0080` | 记录页写保护与空态 |

### 计划本身的四处笔误（实施中已修正）

| # | 位置 | 笔误 | 实际做法 |
|---|---|---|---|
| 1 | Task 1 Step 4 | 写「5 个用例全绿」，但同一节给的测试代码是 7 条 | 按代码块执行，7 条全绿 |
| 2 | Task 3 Step 1 | 称「`getSession` 已经在文件顶部的 import 里」—— 实际没有，那里只有 `listSessionExercises` | 在 `sessionRepo` 的 import 块里补了 `getSession` |
| 3 | Task 3 Step 3d | 结尾写 `reset();`。但在 `create((set, get) => ({ … }))` 的对象字面量里没有这个绑定，照抄会在运行时抛 `ReferenceError: reset is not defined`，Step 4 必然无法变绿 | 写成 `get().reset();` |
| 4 | Task 4 Step 3a | import 块里仍列着 `getSession`，但 Task 3 删掉 `endWorkout` 里那次 reload 之后它已是死代码 | 从 import 列表里去掉 |

### 一次并发提交事故

Task 6 与 Task 8 并行执行，各自 `git add` 自己那一个文件之后再 `git commit`。两次 add 与两次 commit 交错，而 **git 的 index 是共享的** —— Task 8 的 `app/session/summary/[id].tsx` 被夹带进了 Task 6 的提交：

```
dbb065f fix(home): 继续上次训练只在真没结束时出现，并写明是哪一场
 app/(tabs)/index.tsx         | 99 ++++++++++++++++++++++++++++
 app/session/summary/[id].tsx | 28 +++++++-------      ← 这是 Task 8 的改动
```

内容逐字核对无误、没有丢失，只是提交信息与归属对不上（计划 Task 8 Step 5 要求的那条提交信息没有产生对应的 commit）。

**处置：接受现状，不改写历史。** `main` 当时尚未推送，改写技术上可行，但为一条提交信息去重写提交、而当时仍有 agent 在活动，风险明显大于收益。

**教训**：即使每个 agent 都只 `git add` 自己那一个文件，「逐个指定文件」也**防不住** add/commit 交错 —— 因为 add 与 commit 之间隔着一个共享的 index。真正可靠的两条路：并行任务**串行提交**，或者用 `git commit -- <path>`（只提交指定路径，不依赖 index 里别的东西）。本次那句「提交前复跑 `git diff --cached --name-only` 断言只含自己的文件」是在 add 之后、commit 之前做的，仍然会被夹带。

---

## 附：这次刻意不做的事

- **不加时间上限**（「超过 N 小时就作废」）—— 用户的实际流程是每次练完都点结束，正常路径下根本不会留下未结束的训练（设计文档 §2.4）
- **不加独立的「放弃这场训练」按钮** —— 冲突弹窗里的「结束它」就是它，且会进历史，不丢数据
- **不给 `session` 加状态字段、不做迁移** —— 一个 `finished_at IS NULL` 足够表达，加列属于 YAGNI
- **不动备份格式与历史列表查询** —— 进行中的训练仍然不进历史（`listSessionSummaries` 的 `WHERE s.finished_at IS NOT NULL` 保持不变）
- **不处理旧包里的「深蹲写死」** —— 代码里 `7ce93e6` 已经修了，重新打包即生效
