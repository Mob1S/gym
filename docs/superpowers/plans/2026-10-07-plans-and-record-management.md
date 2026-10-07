# 训练计划与记录管理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「新训练复制上一场」换成用户自定义的分化循环计划，并补上训练中删动作、历史里删记录、从别处导记录这三件缺失的能力。

**Architecture:** 计划（分化）独立成两张表，训练用 `session.template_id` 记住自己属于哪一套；「今天该练哪套」是从这个字段推导出来的纯函数，不另存指针。删除一律靠既有的 `ON DELETE CASCADE`。导入的落库路径只有一条，CSV 与手填只是它的两个前端。

**Tech Stack:** React Native 0.86 / Expo SDK 57 / expo-router（typedRoutes）/ TypeScript 6 / zustand / expo-sqlite（真机）+ node:sqlite（测试）/ jest 30 + babel-jest（`testEnvironment: 'node'`，只匹配 `src/**/*.test.ts`）

**Spec:** `docs/superpowers/specs/2026-10-07-plans-and-record-management-design.md`

## Global Constraints

- **所有注释、界面文案、提交信息一律用中文。** 代码里每个导出的函数都要有 JSDoc，写「为什么这么做」而不是「这行做了什么」——仓库现有文件的注释密度就是标准，照着写。
- **界面层（`app/`）永远不直接 import `src/db/`**，数据访问只能经过 `src/repositories/`。store 也不例外，它收 `exec` 参数。
- **`exec` 的用法有两条硬约定**（`src/db/types.ts`）：不传参数时可以跑多语句，传参数时只跑第一条。迁移里的多语句脚本必须**不带参数**调用 `exec.run(sql)`。
- **时间一律存毫秒时间戳**（INTEGER）；**布尔一律存 0/1**。
- **`ORDER BY` 里凡是有 `started_at` 的地方都必须跟 `rowid DESC`**（或对应的列）：毫秒精度会并列，只用时间排序时 SQLite 退化为扫描顺序，语义就反了。
- **测试放同目录的 `*.test.ts`**（不是 `__tests__/`），用 `createNodeExecutor()` / `createMigratedExecutor()`（`src/db/__tests__/nodeExecutor.ts`）建库。
- 每条命令都用 `npx`。
- 跑测试就是 `npx jest`（全量）或 `npx jest <文件路径>`。**不需要**再手动加 `--maxWorkers=1`：`jest.config.js` 里已经写了 `maxWorkers: 1`，因为在受限沙箱里 jest 默认的 worker 池会 `Error: spawn EPERM` 直接崩（表现是「一条测试都跑不起来」，不是「跑得慢」）。这个选项对断言与测试集合没有任何影响。
- **测试文件基线是 20 个、断言 245 条**（M6 之前）。任何时刻的「全绿」都要以这个数字为参照来判断有没有人漏跑了文件 —— 别用行数之类的间接统计去数，会数错。**每个 Task 完成后这个数字都会涨，所以别把它当固定期望**：做完一个 Task 就看一眼「有没有失败的 suite / 用例」，那才是有意义的判据。
- **每个 Task 结束必须同时满足：`npx jest` 全绿 + `npx tsc --noEmit` 干净**，然后才提交。
- **不要自己跑 `git commit`**：本机 `.git` 目录不可写，会报 `Permission denied`。改完代码、跑绿测试即可，提交由编排者统一处理。
- 沙箱下 `src/**` 子目录的写入可能被拒（`Access denied`），改文件请用编辑工具而不是命令行重定向。

## 执行顺序不可颠倒

- M7 的删除要用 M6 的迁移（`session` 表的改动在同一个 v3 里，分两次做要写两次迁移）。
- M8 的导入预览要显示动作名，动作名来自已经存在的动作库。

---

# M6 · 计划与轮转

## Task 1: schema v3 与 `templateId` 进领域类型

**Files:**
- Modify: `src/db/schema.ts`（文件末尾追加两个常量）
- Modify: `src/db/migrations.ts`（`MIGRATIONS` 追加 v3）
- Modify: `src/db/types.ts:46`（`SCHEMA_VERSION`）
- Modify: `src/domain/types.ts`（新增两个接口，`WorkoutSession` 加一个字段）
- Modify: `src/repositories/sessionRepo.ts`（`SessionRow`、`toSession`、`SESSION_COLUMNS`、`createSession`）
- Test: `src/db/migrations.test.ts`（追加两个 describe）
- Test: `src/repositories/backupRepo.test.ts`（修一个类型错误，见 Step 8）

**Interfaces:**
- Produces: `CREATE_TEMPLATE_SQL: string`、`ADD_SESSION_TEMPLATE_SQL: string`（`schema.ts`）
- Produces: `SplitTemplate { id: string; name: string; position: number; createdAt: number }`、`TemplateExercise { id: string; templateId: string; exerciseId: string; position: number }`、`WorkoutSession.templateId: string | null`（`domain/types.ts`）
- Produces: `createSession(exec, name: string | null, templateId: string | null): Promise<WorkoutSession>`

- [ ] **Step 1: 写失败的迁移测试**

在 `src/db/migrations.test.ts` 末尾追加。**注意第二条测试的存在理由**：全新库走的是 `CREATE TABLE` 那条路，而 `ALTER TABLE` 那条路只有「从 v2 升上来的老库」才走得到，不手工造一个 v2 库就永远测不到它——而真机上恰恰全是老库。

```ts
/** 手工造一个 v2 的库：只建 v1/v2 会建的东西，版本号停在 2 */
async function createV2Database(): Promise<ReturnType<typeof createNodeExecutor>['exec']> {
  const { exec } = createNodeExecutor();
  await exec.run(CREATE_META_SQL);
  await exec.run(CREATE_TABLES_SQL);
  await exec.run(CREATE_SETTINGS_SQL);
  await exec.run(
    "INSERT INTO app_meta (key, value) VALUES ('schema_version', '2')",
  );
  return exec;
}

describe('v3 迁移：分化计划', () => {
  it('建出两张新表，并给 session 加上 template_id 列', async () => {
    const { exec } = createNodeExecutor();
    await migrate(exec);

    const names = await tableNames(exec);
    expect(names).toEqual(
      expect.arrayContaining(['split_template', 'template_exercise']),
    );

    const columns = await exec.all<{ name: string }>(
      'PRAGMA table_info(session)',
    );
    expect(columns.map((c) => c.name)).toContain('template_id');
  });

  it('从 v2 老库升级：新列加得上，老数据一行不丢', async () => {
    const exec = await createV2Database();
    await exec.run(
      `INSERT INTO session (id, name, started_at, finished_at, note)
       VALUES ('old-1', '老训练', 1000, 2000, NULL)`,
    );

    await migrate(exec);

    const row = await exec.first<{ name: string; template_id: string | null }>(
      'SELECT name, template_id FROM session WHERE id = ?',
      ['old-1'],
    );
    // 老记录必须还在，且新列是 NULL —— 不能因为加列把数据冲掉
    expect(row?.name).toBe('老训练');
    expect(row?.template_id).toBeNull();
    expect(await getSchemaVersion(exec)).toBe(3);
  });
});
```

同时把文件顶部的 import 改成：

```ts
import { createNodeExecutor } from './__tests__/nodeExecutor';
import { migrate, getSchemaVersion, MIGRATIONS } from './migrations';
import { CREATE_META_SQL, CREATE_SETTINGS_SQL, CREATE_TABLES_SQL } from './schema';
```

- [ ] **Step 2: 跑测试，确认它是红的**

Run: `npx jest src/db/migrations.test.ts`
Expected: FAIL —— `no such table: split_template` 或者 `tableNames` 里没有新表。

- [ ] **Step 3: 加 schema 与迁移**

在 `src/db/schema.ts` **末尾**追加：

```ts
/**
 * 分化计划（训练模板）与它下面的动作。
 *
 * 计划**只存动作清单与顺序**，刻意不存目标组数/重量/次数：目标是计划的一部分时，
 * 用户每改一次计划都要维护几十个数字，而「上次练了多少」本机已经自动沿用了
 * （`setRepo.getLastPerformance`），计划再写一份就是第二处真相，两处必然打架。
 *
 * `template_exercise.exercise_id` 的外键与 `session_exercise` 的同名外键**同向**，
 * 所以备份导入的删除顺序里它排在 `exercise` 之前即可，不需要新的顺序推理。
 */
export const CREATE_TEMPLATE_SQL = `
CREATE TABLE IF NOT EXISTS split_template (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS template_exercise (
  id          TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES split_template(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercise(id),
  position    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_template_exercise_template
  ON template_exercise(template_id);
`;

/**
 * 训练属于哪一套计划。
 *
 * **刻意不写 `REFERENCES split_template(id)`**：`ALTER TABLE ... ADD COLUMN` 加上的
 * 列级外键在 SQLite 里不会被后续写入强制（实测），写一个不生效的约束只会误导后来的人。
 * 改为一条明文约定：**删计划时由 `templateRepo.deleteTemplate` 把引用它的
 * `session.template_id` 置空**。
 *
 * 这一列的作用只有一个：让「今天该练哪一套」推得出来。若改成训练结束后拿动作清单
 * 去反推是哪套计划，用户中途加/删一个动作就会反推失败或错配，而错配的表现是
 * 「轮转莫名跳了一套」——用户看得见，又最难解释。
 */
export const ADD_SESSION_TEMPLATE_SQL =
  'ALTER TABLE session ADD COLUMN template_id TEXT';
```

在 `src/db/migrations.ts` 的 `MIGRATIONS` 数组末尾追加一项，并把顶部 import 改成 `import { ADD_SESSION_TEMPLATE_SQL, CREATE_META_SQL, CREATE_SETTINGS_SQL, CREATE_TABLES_SQL, CREATE_TEMPLATE_SQL } from './schema';`：

```ts
  {
    // v3：分化计划（训练模板）+「这场训练属于哪套计划」。
    //
    // 不能并进 v1/v2：那两项早就发布过，库里的 schema_version 已经是 2 的库
    // 不会再跑它们（migrate 只跑 version > current 的项），新列会永远加不上。
    //
    // ALTER TABLE 这一句**不能带参数**调用：`SqlExecutor` 的约定是无参数时才跑
    // 多语句，而 node:sqlite 的 prepare() 只编译第一条、后面静默丢弃。
    version: 3,
    statements: [CREATE_TEMPLATE_SQL, ADD_SESSION_TEMPLATE_SQL],
  },
```

`src/db/types.ts` 的 `SCHEMA_VERSION` 改成 `export const SCHEMA_VERSION = 3;`（注释里的「必须与 MIGRATIONS 最后一项一致」保持不动）。

- [ ] **Step 4: 跑迁移测试，确认绿了**

Run: `npx jest src/db/migrations.test.ts`
Expected: PASS，6 条（原来 5 条 + 新增… 实际是原 5 条 + 新 2 条 = 7 条）。

- [ ] **Step 5: 加领域类型**

`src/domain/types.ts` 里给 `WorkoutSession` 加字段（放在 `note` 之后）：

```ts
  /**
   * 这一场是按哪套计划练的；null = 没按计划（第一次用 App、计划被删过、
   * 或者从别处导入/手填的记录）。
   *
   * 「今天该练哪一套」就是从这个字段推出来的：取最近一场已结束、且它非空的训练，
   * 在计划列表里往后数一套。**刻意不另存一个「下一个该练第几套」的字段** ——
   * 那就要在跳过、删计划、导入记录、恢复备份四条路径上同步维护它，一旦不符
   * 表现是「轮转莫名跳了一套」。
   */
  templateId: string | null;
```

文件末尾追加：

```ts
/** 一套分化计划（训练模板）。名字与套数全由用户定：推/拉/腿、A/B、上肢/下肢都行 */
export interface SplitTemplate {
  id: string;
  name: string;
  /** 轮转顺序，从 0 开始；界面上的先后就是它 */
  position: number;
  createdAt: number;
}

/** 计划里的一个动作。**计划不含目标重量/次数**，见 `schema.ts` 的说明 */
export interface TemplateExercise {
  id: string;
  templateId: string;
  exerciseId: string;
  /** 在计划里的顺序，从 0 开始 */
  position: number;
}
```

- [ ] **Step 6: 让 `sessionRepo` 认这一列**

`src/repositories/sessionRepo.ts`：

1. `SessionRow` 加 `template_id: string | null;`
2. `toSession` 的返回值加 `templateId: row.template_id,`
3. `SESSION_COLUMNS` 改成 `'id, name, started_at, finished_at, note, template_id'`
4. `createSession` 改成收三个参数：

```ts
/**
 * 开一场新训练。`finishedAt` 与 `note` 一律为空 —— 新训练必然是进行中的。
 *
 * 本函数**不检查是否已有进行中的训练**：「同时只可能有一场进行中」这条不变量
 * 由 `store/activeSession.ts` 的 `startNew` 单独把守（它要先问用户
 * 「接着练还是结束它」）。绕过 store 直接调本函数，就会留下两场进行中的记录。
 *
 * @param exec SQL 执行器
 * @param name 训练名，可为 null（界面不强制命名）
 * @param templateId 这场按哪套计划练；null = 不按计划（见 `WorkoutSession.templateId`）
 * @returns 新建的实体，含已生成的 id 与 `startedAt`（取当前时间）
 */
export async function createSession(
  exec: SqlExecutor,
  name: string | null,
  templateId: string | null,
): Promise<WorkoutSession> {
  const session: WorkoutSession = {
    id: newId(),
    name,
    startedAt: Date.now(),
    finishedAt: null,
    note: null,
    templateId,
  };
  await exec.run(
    'INSERT INTO session (id, name, started_at, finished_at, note, template_id) VALUES (?, ?, ?, NULL, NULL, ?)',
    [session.id, session.name, session.startedAt, session.templateId],
  );
  return session;
}
```

- [ ] **Step 7: 修调用方**

`src/store/activeSession.ts:270` 的 `createSession(exec, name)` 临时改成 `createSession(exec, name, null)`（Task 7 会把它换成真正的计划 id）。

- [ ] **Step 8: 修类型错误并跑全量**

`src/repositories/backupRepo.test.ts` 的 `makeData()` 里那一条 session 字面量加 `templateId: null,`。

Run: `npx tsc --noEmit; npx jest`
Expected: tsc 无输出（干净），jest 全绿（16 个文件）。

> 如果 `npx tsc` 报出别的地方缺 `templateId`，那是因为还有别的 `WorkoutSession` 字面量——按同样方式补 `templateId: null` 即可。**不要**把字段改成可选来绕过：可选意味着「有些地方可以不知道」，而这个字段必须处处有明确答案。

- [ ] **Step 9: 提交**

```bash
git add src/db/schema.ts src/db/migrations.ts src/db/types.ts src/domain/types.ts src/repositories/sessionRepo.ts src/store/activeSession.ts src/db/migrations.test.ts src/repositories/backupRepo.test.ts
git commit -m "feat(db): 分化计划两张表 + session.template_id（迁移 v3）"
```

---

## Task 2: 轮转算法（纯函数）

**Files:**
- Create: `src/domain/rotation.ts`
- Test: `src/domain/rotation.test.ts`

**Interfaces:**
- Consumes: `SplitTemplate`（Task 1）
- Produces: `nextTemplateIndex(templates: { id: string }[], lastTemplateId: string | null): number | null`

- [ ] **Step 1: 写失败的测试**

创建 `src/domain/rotation.test.ts`：

```ts
import { nextTemplateIndex } from './rotation';

/** 三套计划，下标即轮转顺序 */
const THREE = [{ id: 'push' }, { id: 'pull' }, { id: 'legs' }];

describe('nextTemplateIndex', () => {
  it('上一场是第二套时，轮到第三套', () => {
    expect(nextTemplateIndex(THREE, 'pull')).toBe(2);
  });

  it('上一场是最后一套时，绕回第一套', () => {
    // 这就是「循环」本身：不绕回去的话第四场会拿到 null 或者越界
    expect(nextTemplateIndex(THREE, 'legs')).toBe(0);
  });

  it('只有一套计划时永远是它', () => {
    expect(nextTemplateIndex([{ id: 'only' }], 'only')).toBe(0);
  });

  it('上一场不是用计划练的（null）时，从第一套开始', () => {
    expect(nextTemplateIndex(THREE, null)).toBe(0);
  });

  it('上一场用的计划已被删除时，从第一套开始', () => {
    // 计划被删掉之后，session.template_id 被置空、或者留着一个不在列表里的 id，
    // 两种都要能落地，不能算出一个 -1 让界面取到 templates[-1]
    expect(nextTemplateIndex(THREE, 'deleted-plan')).toBe(0);
  });

  it('一套计划都没有时返回 null', () => {
    // 老用户第一次升级上来就是这种状态，startNew 要据此退回「复制上一次」
    expect(nextTemplateIndex([], null)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试，确认它是红的**

Run: `npx jest src/domain/rotation.test.ts`
Expected: FAIL —— `Cannot find module './rotation'`。

- [ ] **Step 3: 实现**

创建 `src/domain/rotation.ts`：

```ts
/**
 * 「今天该练哪一套」。
 *
 * 这是分化循环的全部逻辑，刻意做成纯函数：它要处理的全是边界（只有一套、
 * 绕回第一套、上一场没按计划练、计划已被删），这些边界在纯函数里几行就能
 * 全部锁住，塞进 store 或 SQL 里就只能靠真机试。
 *
 * **轮转指针不单独存**，它是从「最近一场已结束训练用的模板」推出来的（见
 * `WorkoutSession.templateId`）。多存一个「下一个该练第几套」的字段，就要在
 * 跳过、删计划、导入记录、恢复备份四条路径上同步维护它，一旦不符表现是
 * 「轮转莫名跳了一套」——用户看得见，又最难解释。
 */

/**
 * @param templates 全部计划，**顺序必须是轮转顺序**（即按 `position` 升序），
 *   函数按数组下标往后数，不读 `position` 字段
 * @param lastTemplateId 最近一场已结束训练用的计划 id；null = 没有这样的训练
 *   （第一次用、或者之前都是不按计划练的）
 * @returns 这一场该用的计划在 `templates` 里的下标；**没有任何计划时返回 null**，
 *   调用方据此退回旧行为（复制最近一场的动作）
 */
export function nextTemplateIndex(
  templates: { id: string }[],
  lastTemplateId: string | null,
): number | null {
  if (templates.length === 0) return null;

  // `findIndex` 找不到时是 -1，`-1 + 1` 正好是 0（回到第一套），
  // 于是「上一场没按计划练」和「上一场的计划已被删除」两件事不用分开处理。
  const lastIndex = templates.findIndex((t) => t.id === lastTemplateId);
  return (lastIndex + 1) % templates.length;
}
```

- [ ] **Step 4: 跑测试，确认绿了**

Run: `npx jest src/domain/rotation.test.ts`
Expected: PASS，6 条。

- [ ] **Step 5: 提交**

```bash
git add src/domain/rotation.ts src/domain/rotation.test.ts
git commit -m "feat(domain): 分化计划的轮转规则（纯函数，含四条边界）"
```

---

## Task 3: `templateRepo` 的读与改

**Files:**
- Create: `src/repositories/templateRepo.ts`
- Test: `src/repositories/templateRepo.test.ts`

**Interfaces:**
- Consumes: `SplitTemplate` / `TemplateExercise`（Task 1）
- Produces:
  - `TemplateSummary extends SplitTemplate { exerciseCount: number }`
  - `TemplateDetail { template: SplitTemplate; exercises: { templateExercise: TemplateExercise; exerciseName: string }[] }`
  - `listTemplates(exec): Promise<TemplateSummary[]>`
  - `getTemplate(exec, id: string): Promise<TemplateDetail | null>`
  - `createTemplate(exec, name: string): Promise<SplitTemplate>`
  - `renameTemplate(exec, id: string, name: string): Promise<void>`
  - `setTemplateExercises(exec, id: string, exerciseIds: string[]): Promise<TemplateDetail>`

- [ ] **Step 1: 写失败的测试**

创建 `src/repositories/templateRepo.test.ts`：

```ts
import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import type { SqlExecutor } from '../db/types';
import { createCustomExercise } from './exerciseRepo';
import {
  createTemplate,
  getTemplate,
  listTemplates,
  renameTemplate,
  setTemplateExercises,
} from './templateRepo';

/** 造几个动作，返回它们的 id（顺序与传入的名字一一对应） */
async function makeExercises(
  exec: SqlExecutor,
  names: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const exercise = await createCustomExercise(exec, name, '胸', '杠铃');
    ids.push(exercise.id);
  }
  return ids;
}

describe('templateRepo', () => {
  it('空库时没有任何计划', async () => {
    const exec = await createMigratedExecutor();
    expect(await listTemplates(exec)).toEqual([]);
  });

  it('按 position 升序返回计划，并带上动作数', async () => {
    const exec = await createMigratedExecutor();
    const [squat, bench] = await makeExercises(exec, ['深蹲', '卧推']);
    const push = await createTemplate(exec, '推日');
    const legs = await createTemplate(exec, '腿日');
    await setTemplateExercises(exec, push.id, [bench]);
    await setTemplateExercises(exec, legs.id, [squat, bench]);

    const templates = await listTemplates(exec);

    expect(templates.map((t) => t.name)).toEqual(['推日', '腿日']);
    // 动作数必须在这一次查询里就带回来。设置页要列全部计划，
    // 每个计划再查一次动作数就是 N+1 —— 手机上肉眼可见地卡。
    expect(templates.map((t) => t.exerciseCount)).toEqual([1, 2]);
  });

  it('getTemplate 按 position 返回动作，并带上动作名', async () => {
    const exec = await createMigratedExecutor();
    const [squat, bench] = await makeExercises(exec, ['深蹲', '卧推']);
    const legs = await createTemplate(exec, '腿日');
    await setTemplateExercises(exec, legs.id, [squat, bench]);

    const detail = await getTemplate(exec, legs.id);

    expect(detail?.template.name).toBe('腿日');
    expect(detail?.exercises.map((e) => e.exerciseName)).toEqual(['深蹲', '卧推']);
    expect(detail?.exercises.map((e) => e.templateExercise.position)).toEqual([0, 1]);
  });

  it('getTemplate 对不存在的 id 返回 null', async () => {
    const exec = await createMigratedExecutor();
    expect(await getTemplate(exec, 'nope')).toBeNull();
  });

  it('setTemplateExercises 是整体覆盖：删掉的没了、加上的在、顺序按传入的来', async () => {
    const exec = await createMigratedExecutor();
    const [squat, bench, fly] = await makeExercises(exec, ['深蹲', '卧推', '飞鸟']);
    const push = await createTemplate(exec, '推日');

    await setTemplateExercises(exec, push.id, [bench, squat]);
    const detail = await setTemplateExercises(exec, push.id, [fly, bench]);

    expect(detail.exercises.map((e) => e.exerciseName)).toEqual(['飞鸟', '卧推']);
    expect(detail.exercises.map((e) => e.templateExercise.position)).toEqual([0, 1]);
    // 深蹲被覆盖掉了：不是软删，是真的不在这个计划里
    expect(detail.exercises.some((e) => e.exerciseName === '深蹲')).toBe(false);
  });

  it('同一个动作可以在计划里出现两次（有人真的这么练）', async () => {
    const exec = await createMigratedExecutor();
    const [squat] = await makeExercises(exec, ['深蹲']);
    const legs = await createTemplate(exec, '腿日');

    const detail = await setTemplateExercises(exec, legs.id, [squat, squat]);

    expect(detail.exercises).toHaveLength(2);
    // 两条 template_exercise 必须是不同的 id，否则删一条会连带删掉两条
    expect(detail.exercises[0].templateExercise.id).not.toBe(
      detail.exercises[1].templateExercise.id,
    );
  });

  it('renameTemplate 只改名字，动作不受影响', async () => {
    const exec = await createMigratedExecutor();
    const [squat] = await makeExercises(exec, ['深蹲']);
    const legs = await createTemplate(exec, '腿日');
    await setTemplateExercises(exec, legs.id, [squat]);

    await renameTemplate(exec, legs.id, '腿部日');

    const detail = await getTemplate(exec, legs.id);
    expect(detail?.template.name).toBe('腿部日');
    expect(detail?.exercises).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试，确认它是红的**

Run: `npx jest src/repositories/templateRepo.test.ts`
Expected: FAIL —— `Cannot find module './templateRepo'`。

- [ ] **Step 3: 实现**

创建 `src/repositories/templateRepo.ts`：

```ts
import type { SqlExecutor } from '../db/types';
import type { SplitTemplate, TemplateExercise } from '../domain/types';
import { newId } from '../lib/id';

/**
 * 分化计划（训练模板）的读写。
 *
 * 计划的动作清单只有**整体覆盖**一个写入口（`setTemplateExercises`），没有
 * 「加一个/删一个/挪一位」这种细粒度接口：编辑界面就是「本地改一份数组 →
 * 保存时整体覆盖」，比逐个 diff（加哪个、删哪个、谁排第几）简单一个量级，
 * 而且不会出现半应用状态。少一个接口就少一类不同步的 bug。
 */

/** `split_template` 表的原始行 */
interface TemplateRow {
  id: string;
  name: string;
  position: number;
  created_at: number;
}

/** `template_exercise` 表的原始行 */
interface TemplateExerciseRow {
  id: string;
  template_id: string;
  exercise_id: string;
  position: number;
}

/**
 * @param row `split_template` 表的行
 * @returns 领域层的 `SplitTemplate`（snake_case → camelCase）
 */
function toTemplate(row: TemplateRow): SplitTemplate {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    createdAt: row.created_at,
  };
}

/**
 * @param row `template_exercise` 表的行
 * @returns 领域层的 `TemplateExercise`
 */
function toTemplateExercise(row: TemplateExerciseRow): TemplateExercise {
  return {
    id: row.id,
    templateId: row.template_id,
    exerciseId: row.exercise_id,
    position: row.position,
  };
}

/** 计划 + 动作数。列表页要用，见 `listTemplates` */
export interface TemplateSummary extends SplitTemplate {
  /** 这个计划里有几个动作；一次聚合查出来，避免列表页 N+1 */
  exerciseCount: number;
}

/** 一个计划 + 它的动作清单（已带动作名） */
export interface TemplateDetail {
  template: SplitTemplate;
  /** 顺序即 `position` 顺序；动作名在这里就查好，界面不必再查一次 */
  exercises: { templateExercise: TemplateExercise; exerciseName: string }[];
}

/**
 * 列出全部计划，按轮转顺序。
 *
 * 用一次 LEFT JOIN + GROUP BY 把动作数带回来，而不是「查完计划再逐个查动作数」：
 * 设置页要把所有计划一次列出来，N+1 查询在手机上会肉眼可见地卡
 * （`listSessionSummaries` 的注释里写过同一件事）。
 *
 * @param exec SQL 执行器
 * @returns 全部计划，`position` 升序；**一个计划都没有时是空数组**，
 *   界面据此显示「还没有计划」并引导新建
 */
export async function listTemplates(
  exec: SqlExecutor,
): Promise<TemplateSummary[]> {
  const rows = await exec.all<TemplateRow & { exercise_count: number }>(
    `SELECT t.id         AS id,
            t.name       AS name,
            t.position   AS position,
            t.created_at AS created_at,
            COUNT(te.id) AS exercise_count
       FROM split_template t
       LEFT JOIN template_exercise te ON te.template_id = t.id
      GROUP BY t.id
      ORDER BY t.position ASC, t.rowid ASC`,
  );

  return rows.map((row) => ({
    ...toTemplate(row),
    exerciseCount: Number(row.exercise_count),
  }));
}

/**
 * 取一个计划连同它的动作清单。
 *
 * 动作名一步 JOIN 出来：调用方（编辑界面、预览）无一例外都要显示名字，
 * 让它们各自再 `getExercise` 一次既啰嗦又容易漏。
 *
 * @param exec SQL 执行器
 * @param id `split_template.id`
 * @returns 计划与动作；**id 不存在时返回 null**（调用方据此显示「这个计划不存在」）
 */
export async function getTemplate(
  exec: SqlExecutor,
  id: string,
): Promise<TemplateDetail | null> {
  const templateRow = await exec.first<TemplateRow>(
    'SELECT id, name, position, created_at FROM split_template WHERE id = ?',
    [id],
  );
  if (!templateRow) return null;

  const exerciseRows = await exec.all<TemplateExerciseRow & { exercise_name: string }>(
    `SELECT te.id          AS id,
            te.template_id AS template_id,
            te.exercise_id AS exercise_id,
            te.position    AS position,
            e.name         AS exercise_name
       FROM template_exercise te
       JOIN exercise e ON e.id = te.exercise_id
      WHERE te.template_id = ?
      ORDER BY te.position ASC, te.rowid ASC`,
    [id],
  );

  return {
    template: toTemplate(templateRow),
    exercises: exerciseRows.map((row) => ({
      templateExercise: toTemplateExercise(row),
      exerciseName: row.exercise_name,
    })),
  };
}

/**
 * 新建一个空计划，排在最后。
 *
 * @param exec SQL 执行器
 * @param name 计划名，调用方需保证非空（界面上空名字会退回「新计划」）
 * @returns 新建的计划；**一个动作也没有**，由编辑界面引导用户加
 */
export async function createTemplate(
  exec: SqlExecutor,
  name: string,
): Promise<SplitTemplate> {
  const row = await exec.first<{ next: number | null }>(
    'SELECT MAX(position) + 1 AS next FROM split_template',
  );

  const template: SplitTemplate = {
    id: newId(),
    name,
    position: row?.next ?? 0,
    createdAt: Date.now(),
  };

  await exec.run(
    'INSERT INTO split_template (id, name, position, created_at) VALUES (?, ?, ?, ?)',
    [template.id, template.name, template.position, template.createdAt],
  );

  return template;
}

/**
 * 改计划名。
 *
 * @param exec SQL 执行器
 * @param id 目标计划
 * @param name 新名字
 */
export async function renameTemplate(
  exec: SqlExecutor,
  id: string,
  name: string,
): Promise<void> {
  await exec.run('UPDATE split_template SET name = ? WHERE id = ?', [name, id]);
}

/**
 * 整个替换一个计划的动作清单与顺序。
 *
 * **先删后插**，在一个事务里：删一半插一半失败的话，用户会得到一个半残的计划，
 * 而他在界面上看到的仍然是自己编排好的那份，下次进来才发现少了一半。
 *
 * 允许同一个动作重复出现（有人真的会练两轮），所以每次插入都用 `newId()` 生成
 * 新的 `template_exercise.id`，不能拿 `exerciseId` 当 id。
 *
 * @param exec SQL 执行器
 * @param id 目标计划
 * @param exerciseIds 动作库里的动作 id，**数组顺序就是计划里的顺序**
 * @returns 覆盖之后的计划详情（界面直接拿它刷新，不必再查一次）
 */
export async function setTemplateExercises(
  exec: SqlExecutor,
  id: string,
  exerciseIds: string[],
): Promise<TemplateDetail> {
  await exec.run('BEGIN');
  try {
    await exec.run('DELETE FROM template_exercise WHERE template_id = ?', [id]);
    for (const [index, exerciseId] of exerciseIds.entries()) {
      await exec.run(
        'INSERT INTO template_exercise (id, template_id, exercise_id, position) VALUES (?, ?, ?, ?)',
        [newId(), id, exerciseId, index],
      );
    }
    await exec.run('COMMIT');
  } catch (error) {
    // 回滚自身也可能抛（连接已断之类）。调用方更需要知道「为什么失败」，
    // 所以回滚的异常吞掉，抛出去的必须是原始异常。
    try {
      await exec.run('ROLLBACK');
    } catch {
      // 忽略：下面抛原始异常
    }
    throw error;
  }

  const detail = await getTemplate(exec, id);
  if (!detail) {
    throw new Error(`计划 ${id} 在写入后查不到了`);
  }
  return detail;
}
```

- [ ] **Step 4: 跑测试，确认绿了**

Run: `npx jest src/repositories/templateRepo.test.ts`
Expected: PASS，7 条。

- [ ] **Step 5: 提交**

```bash
git add src/repositories/templateRepo.ts src/repositories/templateRepo.test.ts
git commit -m "feat(repo): 分化计划的读写（整体覆盖式保存动作清单）"
```

---

## Task 4: `templateRepo` 的删除与排序

**Files:**
- Modify: `src/repositories/templateRepo.ts`（追加三个函数）
- Test: `src/repositories/templateRepo.test.ts`（追加两个 describe）

**Interfaces:**
- Consumes: Task 1 的 `sessionRepo.createSession`、Task 3 的 `templateRepo`
- Produces:
  - `deleteTemplate(exec, id: string): Promise<{ affectedSessions: number }>`
  - `moveTemplate(exec, currentPosition: number, targetPosition: number): Promise<void>`

- [ ] **Step 1: 写失败的测试**

在 `src/repositories/templateRepo.test.ts` 末尾追加（并把 `createSession` 加进 import：`import { createSession } from './sessionRepo';`，把 `deleteTemplate, moveTemplate` 加进 `./templateRepo` 的 import）：

```ts
describe('删除计划', () => {
  it('删掉之后它不再出现在列表里，剩余计划的 position 不留空洞', async () => {
    const exec = await createMigratedExecutor();
    await createTemplate(exec, '推日');
    const pull = await createTemplate(exec, '拉日');
    await createTemplate(exec, '腿日');

    await deleteTemplate(exec, pull.id);

    const templates = await listTemplates(exec);
    expect(templates.map((t) => t.name)).toEqual(['推日', '腿日']);
    // 空洞本身不会让 order by 出错，但以后要把计划插到中间（上移/下移、
    // 新建到指定位置）就会错位 —— 是个埋着的坑。
    expect(templates.map((t) => t.position)).toEqual([0, 1]);
  });

  it('删计划之后，用它练过的历史训练还在，只是不再指向任何计划', async () => {
    const exec = await createMigratedExecutor();
    const legs = await createTemplate(exec, '腿日');
    const history = await createSession(exec, '腿部日', legs.id);

    const result = await deleteTemplate(exec, legs.id);

    expect(result.affectedSessions).toBe(1);
    const row = await exec.first<{ name: string; template_id: string | null }>(
      'SELECT name, template_id FROM session WHERE id = ?',
      [history.id],
    );
    // 历史记录**绝不能跟着计划一起消失**：用户练过的组是他的数据，
    // 计划只是编排。这里同时挡住「顺手把 session 也删了」那种实现。
    expect(row?.name).toBe('腿部日');
    expect(row?.template_id).toBeNull();
  });
});

describe('调整计划的轮转顺序', () => {
  it('把第二个上移一位，两位互换', async () => {
    const exec = await createMigratedExecutor();
    await createTemplate(exec, '推日');
    await createTemplate(exec, '拉日');
    await createTemplate(exec, '腿日');

    await moveTemplate(exec, 1, 0);

    expect((await listTemplates(exec)).map((t) => t.name)).toEqual([
      '拉日',
      '推日',
      '腿日',
    ]);
  });

  it('把第一个下移一位', async () => {
    const exec = await createMigratedExecutor();
    await createTemplate(exec, '推日');
    await createTemplate(exec, '拉日');

    await moveTemplate(exec, 0, 1);

    expect((await listTemplates(exec)).map((t) => t.name)).toEqual(['拉日', '推日']);
  });

  it('目标是同一个位置时什么都不做（不会把 position 弄重）', async () => {
    const exec = await createMigratedExecutor();
    await createTemplate(exec, '推日');
    await createTemplate(exec, '拉日');

    await moveTemplate(exec, 0, 0);

    const templates = await listTemplates(exec);
    expect(templates.map((t) => t.name)).toEqual(['推日', '拉日']);
    expect(templates.map((t) => t.position)).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: 跑测试，确认它是红的**

Run: `npx jest src/repositories/templateRepo.test.ts`
Expected: FAIL —— `deleteTemplate is not a function` / `moveTemplate is not a function`。

- [ ] **Step 3: 实现**

在 `src/repositories/templateRepo.ts` **末尾**追加：

```ts
/**
 * 删掉一个计划。
 *
 * 两件必须一起做的事：
 * 1. **把引用它的 `session.template_id` 置空。** 这一列刻意没有外键约束
 *    （SQLite 对 `ALTER TABLE` 加的列级外键不强制，见 `schema.ts`），所以
 *    置空这件事只能由这里负责。不置空的话，一场老训练会一直指着一个不存在的
 *    计划 —— 轮转虽然能容错（`nextTemplateIndex` 会回到第一套），但「这场是按
 *    哪套计划练的」就永久错了。
 * 2. **重排剩余计划的 `position`**，不留空洞。
 *
 * 注意这句 `UPDATE` 是安全的：它上面的 `DELETE` 只碰 `split_template` 与
 * `template_exercise`，不碰 `session`，所以不会出现「删 session 的同时又在读
 * session 的子表」那种 `database table is locked`。
 *
 * @param exec SQL 执行器
 * @param id 要删的计划
 * @returns 有多少场历史训练不再指向任何计划（界面可以据此说一句「N 场历史记录
 *   保留着，只是不再属于某个计划」）。**没有历史引用时是 0**
 */
export async function deleteTemplate(
  exec: SqlExecutor,
  id: string,
): Promise<{ affectedSessions: number }> {
  const target = await exec.first<{ position: number }>(
    'SELECT position FROM split_template WHERE id = ?',
    [id],
  );
  if (!target) return { affectedSessions: 0 };

  const affected = await exec.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM session WHERE template_id = ?',
    [id],
  );

  await exec.run('BEGIN');
  try {
    await exec.run('UPDATE session SET template_id = NULL WHERE template_id = ?', [id]);
    await exec.run('DELETE FROM split_template WHERE id = ?', [id]);
    // template_exercise 靠外键级联删掉（建表时就写了 ON DELETE CASCADE）
    await exec.run(
      'UPDATE split_template SET position = position - 1 WHERE position > ?',
      [target.position],
    );
    await exec.run('COMMIT');
  } catch (error) {
    try {
      await exec.run('ROLLBACK');
    } catch {
      // 忽略：下面抛原始异常
    }
    throw error;
  }

  return { affectedSessions: Number(affected?.n ?? 0) };
}

/**
 * 交换两个位置上的计划，用来给列表做上移/下移。
 *
 * 收的是**位置号**而不是计划 id：界面手里就是 `listTemplates` 回来的数组，
 * 上移就是把第 i 项和它前一项换一下，直接给出两个位置号最省事，
 * 也免了「相邻是谁」这种要再查一次库的推理。
 *
 * **必须先把当前那一行挪到一个不冲突的临时位置**（这里是 -1）。直接写两步
 * `UPDATE ... WHERE position = ?` 会两句互相抵消：第一步把当前行写到
 * `targetPosition` 之后，第二步的 `WHERE position = targetPosition` 会同时命中
 * 「刚移动的那一行」和「原本就在那一行的那一个」，于是把两者一起改回原处 ——
 * 顺序纹丝不动，而且**不报任何错**（实测：`node:sqlite` 上三种写法里只有这一种
 * 真能互换）。改写成按 id 定位也不行：第一步之后两行同名，谁都分不出来。
 *
 * `-1` 不会与任何真实 `position` 撞车（`createTemplate` 取的是 `MAX(position) + 1`，
 * 从 0 往上长）。中间那两步之间没有任何读操作，整个互换跑在一个事务里。
 *
 * @param exec SQL 执行器
 * @param currentPosition 要移动的计划当前的位置
 * @param targetPosition 它要去的位置；**与当前相同时直接返回**，不做任何写入
 */
export async function moveTemplate(
  exec: SqlExecutor,
  currentPosition: number,
  targetPosition: number,
): Promise<void> {
  if (currentPosition === targetPosition) return;

  await exec.run('BEGIN');
  try {
    // 1) 当前行让位：挪到临时位置，`currentPosition` 空出来
    await exec.run(
      'UPDATE split_template SET position = ? WHERE position = ?',
      [-1, currentPosition],
    );
    // 2) 原本占着目标位置的那一行补进空出来的位置
    await exec.run(
      'UPDATE split_template SET position = ? WHERE position = ?',
      [currentPosition, targetPosition],
    );
    // 3) 被移动的那一行落到目标位置
    await exec.run(
      'UPDATE split_template SET position = ? WHERE position = ?',
      [targetPosition, -1],
    );
    await exec.run('COMMIT');
  } catch (error) {
    try {
      await exec.run('ROLLBACK');
    } catch {
      // 忽略：下面抛原始异常
    }
    throw error;
  }
}
```

> **实施后补记（这一处的代码块原本是错的，已改）。** 上面这个函数体最初写的是「两句
> `UPDATE ... WHERE position = ?` 按 position 对调」。实测在 `node:sqlite` 上那是
> **静默无效**的：`position` 没有唯一约束，第一句跑完后两行同处一个 `position`，
> 第二句同时命中两者、把它们一起改回原处，顺序纹丝不动且不报错 —— 两条测试红了才
> 发现。当时还试过「先 `SELECT` 出 id、第二句按 id 定位」，同样无效。
> 用真实 SQLite 跑过三种写法，只有「挪到临时位置 -1 → 目标行补位 → 被移动行落位」
> 三步真能互换。**教训**：涉及「无唯一约束的排序列对调」的 SQL，不要靠推理，写下来
> 就在真实引擎上跑一遍 —— 这类错误的特征是**不报错**。

- [ ] **Step 4: 跑测试，确认绿了**

Run: `npx jest src/repositories/templateRepo.test.ts`
Expected: PASS，12 条。

- [ ] **Step 5: 提交**

```bash
git add src/repositories/templateRepo.ts src/repositories/templateRepo.test.ts
git commit -m "feat(repo): 删计划（不伤历史）与上移下移"
```

---

## Task 5: 备份带上计划（格式 1 → 2）

> **前置：Task 4 必须先完成。** 这一步要把 `templateRepo` 的 `toTemplate` / `toTemplateExercise` 与两个 Row 接口加上 `export` 供 `backupRepo` 复用，而 Task 4 也在追加同一个文件的函数。两者并行会在同一个文件上互相覆盖 —— 所以 **Task 5 不能与 Task 4 同时跑**。

**Files:**
- Modify: `src/domain/backup.ts`
- Modify: `src/repositories/backupRepo.ts`
- Test: `src/domain/backup.test.ts`（追加）
- Test: `src/repositories/backupRepo.test.ts`（追加 + 修 `makeData`）

**Interfaces:**
- Consumes: Task 1 的 `SplitTemplate` / `TemplateExercise` / `WorkoutSession.templateId`
- Produces:
  - `BACKUP_VERSION = 2`
  - `BackupData` 加 `templates: SplitTemplate[]`、`templateExercises: TemplateExercise[]`
  - `exportAll` / `importAll` 覆盖这两张表
  - **`version: 1` 的老备份仍可导入**（模板两数组缺失按空数组、`session.templateId` 缺失按 null）

- [ ] **Step 1: 写失败的测试**

在 `src/domain/backup.test.ts` 末尾追加（顶部 import 按需补）：

```ts
describe('备份格式 2', () => {
  it('BACKUP_VERSION 是 2', () => {
    expect(BACKUP_VERSION).toBe(2);
  });

  it('version 1 的老备份仍然能导入，模板按空数组处理', () => {
    // 这条是硬要求：用户手上已经导出的备份文件不能因为升级 App 就作废。
    // 老文件里既没有 templates 数组，session 里也没有 templateId 字段。
    const legacy = {
      format: BACKUP_FORMAT,
      version: 1,
      schemaVersion: 2,
      exportedAt: NOW,
      data: {
        exercises: [
          {
            id: 'ex-1',
            name: '卧推',
            muscleGroup: '胸',
            equipment: '杠铃',
            isCustom: true,
            isArchived: false,
            createdAt: NOW,
          },
        ],
        sessions: [
          {
            id: 'sess-1',
            name: '推日',
            startedAt: NOW,
            finishedAt: NOW + 1000,
            note: null,
          },
        ],
        sessionExercises: [
          { id: 'se-1', sessionId: 'sess-1', exerciseId: 'ex-1', position: 0, note: null },
        ],
        sets: [
          {
            id: 'set-1',
            sessionExerciseId: 'se-1',
            position: 0,
            weight: 60,
            reps: 8,
            isCompleted: true,
            restSeconds: null,
            restStartedAt: null,
            completedAt: NOW + 1000,
          },
        ],
      },
    };

    const result = validateBackup(legacy);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backup.data.templates).toEqual([]);
    expect(result.backup.data.templateExercises).toEqual([]);
    expect(result.backup.data.sessions[0].templateId).toBeNull();
  });

  it('version 3（比当前新）仍然被拒绝', () => {
    const result = validateBackup({
      format: BACKUP_FORMAT,
      version: 3,
      schemaVersion: 3,
      exportedAt: NOW,
      data: {},
    });
    expect(result.ok).toBe(false);
  });

  it('引用了不存在的计划时被拒（引用完整性）', () => {
    const result = validateBackup({
      format: BACKUP_FORMAT,
      version: 2,
      schemaVersion: 3,
      exportedAt: NOW,
      data: {
        exercises: [
          {
            id: 'ex-1',
            name: '卧推',
            muscleGroup: '胸',
            equipment: '杠铃',
            isCustom: true,
            isArchived: false,
            createdAt: NOW,
          },
        ],
        sessions: [],
        sessionExercises: [],
        sets: [],
        templates: [],
        templateExercises: [
          { id: 'te-1', templateId: 'missing', exerciseId: 'ex-1', position: 0 },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('data.templateExercises 第 1 条');
  });
});
```

> `NOW` 在 `src/domain/backup.test.ts` 里如果没有定义，就在文件顶部加一句 `const NOW = 1_789_560_000_000;`（`backupRepo.test.ts` 里用的是这个值）。写之前先看一眼那个文件已有的辅助变量，**用已有的，别改名**。

- [ ] **Step 2: 跑测试，确认它是红的**

Run: `npx jest src/domain/backup.test.ts`
Expected: FAIL —— `BACKUP_VERSION` 还是 1，且 `data.templates` 是 `undefined`。

- [ ] **Step 3: 改 `src/domain/backup.ts`**

1. 版本号与文档：

```ts
/**
 * 备份格式版本。
 *
 * v1 只带四张表（动作/训练/训练动作/组）。
 * v2 多带分化计划两张表与 `session.templateId`。
 *
 * **v1 的文件必须一直能导入**（见 `validateBackup` 里对缺失字段的容忍）：
 * 用户手上已经导出的备份不能因为 App 升级就作废 —— 那比新功能没做更严重。
 * 读到比当前**更大**的版本仍然拒绝，绝不能猜着读。
 */
export const BACKUP_VERSION = 2;
```

2. `BackupData` 加两个数组：

```ts
export interface BackupData {
  exercises: Exercise[];
  sessions: WorkoutSession[];
  sessionExercises: SessionExercise[];
  sets: SetEntry[];
  /** 分化计划。**v1 的老文件里没有这个数组**，读到时按空数组处理 */
  templates: SplitTemplate[];
  /** 计划里的动作。同上 */
  templateExercises: TemplateExercise[];
}
```

（import 加上 `SplitTemplate, TemplateExercise`。）

3. `normalizeSession` 里加 `templateId`，**用宽容读法**（老文件里没有这个字段）：

> ⚠️ **Task 1 已经在这里写死了一行 `templateId: null`**（当时是为了让 tsc 通过，备份格式还没升级）。所以这一步**不是「加上字段」，而是「把那个写死的 null 改成真的去读」** —— 直接照抄下面这段替换掉 `note: note.value,` 之后的那一行 `templateId: null,`。只加读法、忘了删那行写死的，会出现重复键（后者覆盖前者，备份里存过的 templateId 永远读不回来，而且不报错）。

```ts
  // 老备份（version 1）里没有 templateId 字段，缺失按 null 处理。
  // 这里刻意不用 takeNullableString：那个要求字段必须存在且显式为 null，
  // 对 v1 文件会直接判失败 —— 等于把老备份全废掉。
  //
  // 也不能写成「读出来直接塞进返回值」：那样一个数字或对象会**静默**进库
  // （JSON 里任何类型都能是任何东西），之后轮转把它们当 id 比较永远不相等，
  // 表现为「计划莫名其妙不轮转了」。类型不合法要按下面这样显式失败。
  const rawTemplateId = raw.templateId;
  let templateId: string | null = null;
  if (rawTemplateId !== undefined && rawTemplateId !== null) {
    if (typeof rawTemplateId !== 'string' || rawTemplateId.length === 0) {
      return {
        ok: false,
        reason: `${label} 的 templateId 必须是非空字符串或 null（收到 ${describe(rawTemplateId)}）`,
      };
    }
    templateId = rawTemplateId;
  }
```

并把返回值改成（**替换掉 Task 1 留下的那一行写死的 `templateId: null,`，不是新增一行**）：

```ts
      note: note.value,
      templateId,
```

4. 新增 `normalizeSplitTemplate` 与 `normalizeTemplateExercise`，照 `normalizeExercise` 的写法：

```ts
function normalizeSplitTemplate(raw: unknown, index: number): FieldResult<SplitTemplate> {
  const label = `data.templates 第 ${index + 1} 条`;
  if (!isPlainObject(raw)) {
    return { ok: false, reason: `${label} 必须是对象（收到 ${describe(raw)}）` };
  }
  const id = takeString(raw, 'id', `${label} 的 id`);
  if (!id.ok) return id;
  const name = takeString(raw, 'name', `${label} 的 name`);
  if (!name.ok) return name;
  const position = takeInteger(raw, 'position', `${label} 的 position`);
  if (!position.ok) return position;
  const createdAt = takeFiniteNumber(raw, 'createdAt', `${label} 的 createdAt`);
  if (!createdAt.ok) return createdAt;
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      position: position.value,
      createdAt: createdAt.value,
    },
  };
}

function normalizeTemplateExercise(
  raw: unknown,
  index: number,
): FieldResult<TemplateExercise> {
  const label = `data.templateExercises 第 ${index + 1} 条`;
  if (!isPlainObject(raw)) {
    return { ok: false, reason: `${label} 必须是对象（收到 ${describe(raw)}）` };
  }
  const id = takeString(raw, 'id', `${label} 的 id`);
  if (!id.ok) return id;
  const templateId = takeString(raw, 'templateId', `${label} 的 templateId`);
  if (!templateId.ok) return templateId;
  const exerciseId = takeString(raw, 'exerciseId', `${label} 的 exerciseId`);
  if (!exerciseId.ok) return exerciseId;
  const position = takeInteger(raw, 'position', `${label} 的 position`);
  if (!position.ok) return position;
  return {
    ok: true,
    value: {
      id: id.value,
      templateId: templateId.value,
      exerciseId: exerciseId.value,
      position: position.value,
    },
  };
}
```

5. `validateBackup` 里，四个数组之后**按「缺失即空数组」**读这两张新表：

```ts
  // v1 的老文件里没有这两个数组。**缺失按空数组处理**，其余情况照常严格校验。
  const templates =
    data.templates === undefined
      ? ({ ok: true, value: [] } as const)
      : normalizeList(data, 'templates', normalizeSplitTemplate);
  if (!templates.ok) return fail(templates.reason);

  const templateExercises =
    data.templateExercises === undefined
      ? ({ ok: true, value: [] } as const)
      : normalizeList(data, 'templateExercises', normalizeTemplateExercise);
  if (!templateExercises.ok) return fail(templateExercises.reason);
```

6. id 查重列表加这两项：

```ts
  const lists: { label: string; items: { id: string }[] }[] = [
    { label: 'data.exercises', items: exercises.value },
    { label: 'data.sessions', items: sessions.value },
    { label: 'data.sessionExercises', items: sessionExercises.value },
    { label: 'data.sets', items: sets.value },
    { label: 'data.templates', items: templates.value },
    { label: 'data.templateExercises', items: templateExercises.value },
  ];
```

7. 引用完整性加两条检查：

```ts
  const templateIds = new Set(templates.value.map((template) => template.id));
  for (let i = 0; i < templateExercises.value.length; i += 1) {
    const item = templateExercises.value[i];
    const label = `data.templateExercises 第 ${i + 1} 条`;
    if (!templateIds.has(item.templateId)) {
      return fail(
        `${label} 的 templateId ${JSON.stringify(item.templateId)} 在 data.templates 里找不到对应的计划（引用完整性）`,
      );
    }
    if (!exerciseIds.has(item.exerciseId)) {
      return fail(
        `${label} 的 exerciseId ${JSON.stringify(item.exerciseId)} 在 data.exercises 里找不到对应的动作（引用完整性）`,
      );
    }
  }
```

8. 返回值里的 `data` 补上两个数组。

- [ ] **Step 4: 改 `src/repositories/backupRepo.ts`**

`exportAll` 里加两张表的导出（照现有四张表的写法，`ORDER BY rowid ASC`）：

```ts
  // 计划两张表也用 rowid 升序：`position` 相同时（理论上不该有，但导入的
  // 备份可能带进来）谁在前只能靠插入顺序还原。
  const templates = (
    await exec.all<TemplateRow>(
      'SELECT id, name, position, created_at FROM split_template ORDER BY rowid ASC',
    )
  ).map(toTemplate);

  const templateExercises = (
    await exec.all<TemplateExerciseRow>(
      'SELECT id, template_id, exercise_id, position FROM template_exercise ORDER BY rowid ASC',
    )
  ).map(toTemplateExercise);
```

> `toTemplate` / `toTemplateExercise` / 两个 Row 接口目前是 `templateRepo.ts` 里的**私有**声明。把它们加上 `export`（照 `exerciseRepo` 对 `ExerciseRow` / `toExercise` 的做法——那个文件顶上写着「导出给 backupRepo 复用」），然后在 `backupRepo.ts` 里 import 进来。**不要在新文件里重抄一份映射**：两份映射迟早漂移，表现是「导出的文件字段对不上」，极难排查。

`buildBackup` 的调用补上两个数组。

`importAll` 里：
- 删除顺序改成 `set_entry → session_exercise → session → template_exercise → split_template → exercise`
  （`template_exercise` 必须在 `exercise` **之前**删：它的 `exercise_id` 引用 `exercise(id)`。）
- 插入顺序：`exercises → templates → templateExercises → sessions → sessionExercises → sets`
  （`template_exercise.template_id` 引用 `split_template(id)`，所以计划要先于它的动作；`session.template_id` 没有外键，顺序无所谓，但放在 `sessions` 之前更符合直觉。）
- `session` 的 INSERT 多一列 `template_id`。

- [ ] **Step 5: 跑测试，确认绿了**

Run: `npx jest src/domain/backup.test.ts src/repositories/backupRepo.test.ts`
Expected: PASS。

然后在 `src/repositories/backupRepo.test.ts` 的 `makeData()` 里给 `data` 补上 `templates: [], templateExercises: []`，并追加一条往返测试：

```ts
  it('计划与 session 的 templateId 能原样导出再导入', async () => {
    const exec = await createMigratedExecutor();
    const exercise = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const template = await createTemplate(exec, '腿日');
    await setTemplateExercises(exec, template.id, [exercise.id]);
    await createSession(exec, '腿部日', template.id);

    const backup = await exportAll(exec);

    expect(backup.data.templates.map((t) => t.name)).toEqual(['腿日']);
    expect(backup.data.templateExercises).toHaveLength(1);
    expect(backup.data.sessions[0].templateId).toBe(template.id);

    // 换一个干净的库导入，两样都要一模一样地回来
    const fresh = await createMigratedExecutor();
    await importAll(fresh, backup);

    const reloaded = await getTemplate(fresh, template.id);
    expect(reloaded?.exercises.map((e) => e.exerciseName)).toEqual(['深蹲']);
    const row = await fresh.first<{ template_id: string | null }>(
      'SELECT template_id FROM session WHERE id = ?',
      [backup.data.sessions[0].id],
    );
    expect(row?.template_id).toBe(template.id);
  });
```

（import 补 `createTemplate, getTemplate, setTemplateExercises`。）

- [ ] **Step 6: 提交**

```bash
git add src/domain/backup.ts src/repositories/backupRepo.ts src/domain/backup.test.ts src/repositories/backupRepo.test.ts
git commit -m "feat(backup): 备份带上分化计划（格式 2），且 v1 老备份仍可导入"
```

---

## Task 6: `startNew` 走轮转

**Files:**
- Modify: `src/store/activeSession.ts`
- Test: `src/store/activeSession.test.ts`（追加一个 describe）

**Interfaces:**
- Consumes: Task 2 `nextTemplateIndex`、Task 3 `listTemplates` / `getTemplate`、Task 1 `createSession`
- Produces:
  - `sessionRepo.findLatestTemplateId(exec): Promise<string | null>`
  - `startNew(exec, name, templateId?: string | null): Promise<StartResult>`
  - `useActiveSession` 新增 `startNewWithTemplate(exec, name, templateId): Promise<StartResult>`（界面「换一个计划」用）

- [ ] **Step 1: 写失败的测试**

在 `src/store/activeSession.test.ts` 末尾追加（import 补 `createTemplate, setTemplateExercises, listTemplates` 与 `listSessionExercises` 已有的那个）：

```ts
/**
 * 造一套计划并把它填满动作。返回计划 id。
 * `names` 决定动作清单，顺序即计划里的顺序。
 */
async function setupTemplate(
  exec: SqlExecutor,
  templateName: string,
  exerciseNames: string[],
): Promise<string> {
  const template = await createTemplate(exec, templateName);
  const ids: string[] = [];
  for (const name of exerciseNames) {
    const exercise = await createCustomExercise(exec, name, '胸', '杠铃');
    ids.push(exercise.id);
  }
  await setTemplateExercises(exec, template.id, ids);
  return template.id;
}

describe('开始新训练时按分化循环取计划', () => {
  beforeEach(() => {
    useActiveSession.getState().reset();
  });

  it('一套计划、一场都没练过时，用第一套', async () => {
    const exec = await createMigratedExecutor();
    await setupTemplate(exec, '推日', ['卧推', '飞鸟']);

    await useActiveSession.getState().startNew(exec, null);

    const { session, exercises } = useActiveSession.getState();
    expect(exercises.map((e) => e.exerciseName)).toEqual(['卧推', '飞鸟']);
    // 这一场要记住自己是按哪套计划练的，否则下一场推不出该轮到谁
    expect(session?.templateId).not.toBeNull();
  });

  it('练完两场之后轮到第三套，第四场绕回第一套', async () => {
    const exec = await createMigratedExecutor();
    const push = await setupTemplate(exec, '推日', ['卧推']);
    const pull = await setupTemplate(exec, '拉日', ['划船']);
    const legs = await setupTemplate(exec, '腿日', ['深蹲']);

    await useActiveSession.getState().startNew(exec, null);
    expect(useActiveSession.getState().session?.templateId).toBe(push);
    await useActiveSession.getState().endWorkout(exec);

    await useActiveSession.getState().startNew(exec, null);
    expect(useActiveSession.getState().session?.templateId).toBe(pull);
    await useActiveSession.getState().endWorkout(exec);

    await useActiveSession.getState().startNew(exec, null);
    expect(useActiveSession.getState().session?.templateId).toBe(legs);
    expect(useActiveSession.getState().exercises.map((e) => e.exerciseName)).toEqual([
      '深蹲',
    ]);
    await useActiveSession.getState().endWorkout(exec);

    // 循环：第四场回到推日，而不是没有计划可用
    await useActiveSession.getState().startNew(exec, null);
    expect(useActiveSession.getState().session?.templateId).toBe(push);
  });

  it('一套计划都没有时，维持旧行为：复制上一次已结束训练的动作', async () => {
    const exec = await createMigratedExecutor();
    await setupFinishedSession(exec, ['深蹲', '卧推']);

    await useActiveSession.getState().startNew(exec, null);

    const { session, exercises } = useActiveSession.getState();
    expect(exercises.map((e) => e.exerciseName)).toEqual(['深蹲', '卧推']);
    // 没按任何计划练，所以是 null —— 这样它不会参与轮转
    expect(session?.templateId).toBeNull();
  });

  it('startNewWithTemplate 直接用指定的计划，不管轮转轮到谁', async () => {
    const exec = await createMigratedExecutor();
    const push = await setupTemplate(exec, '推日', ['卧推']);
    await setupTemplate(exec, '拉日', ['划船']);

    // 轮转本该给出「推日」，用户主动改选「拉日」
    const pull = (await listTemplates(exec))[1].id;
    await useActiveSession.getState().startNewWithTemplate(exec, null, pull);

    expect(useActiveSession.getState().session?.templateId).toBe(pull);
    expect(useActiveSession.getState().exercises.map((e) => e.exerciseName)).toEqual([
      '划船',
    ]);
    // 推日那套没被动过
    expect(push).not.toBe(pull);
  });

  it('计划被删掉之后，轮转回到第一套而不是卡住', async () => {
    const exec = await createMigratedExecutor();
    const push = await setupTemplate(exec, '推日', ['卧推']);
    const pull = await setupTemplate(exec, '拉日', ['划船']);

    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().endWorkout(exec);
    // 第二场用的是 pull，现在把 pull 删掉
    await useActiveSession.getState().startNew(exec, null);
    expect(useActiveSession.getState().session?.templateId).toBe(pull);
    await useActiveSession.getState().endWorkout(exec);
    await deleteTemplate(exec, pull);

    await useActiveSession.getState().startNew(exec, null);
    expect(useActiveSession.getState().session?.templateId).toBe(push);
  });

  it('按计划开训练时，计划里的每个动作都预建了待完成的组', async () => {
    const exec = await createMigratedExecutor();
    await setupTemplate(exec, '推日', ['卧推', '飞鸟']);

    await useActiveSession.getState().startNew(exec, null);

    // 和复制上一次那条路径一样：没有待完成的组，「完成这组」会毫无反应
    for (const item of useActiveSession.getState().exercises) {
      expect(item.sets.length).toBeGreaterThanOrEqual(1);
      expect(item.sets.every((s) => s.isCompleted === false)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 跑测试，确认它是红的**

Run: `npx jest src/store/activeSession.test.ts`
Expected: FAIL —— `startNewWithTemplate is not a function`，且 `templateId` 全是 null。

- [ ] **Step 3: 加 `findLatestTemplateId`**

在 `src/repositories/sessionRepo.ts` 末尾追加：

```ts
/**
 * 最近一场**已结束且按计划练的**训练用的是哪套计划。轮转规则唯一的输入。
 *
 * 三个条件缺一不可：
 * - `finished_at IS NOT NULL` —— 进行中的那一场还没练完，不能算进轮转；
 * - `template_id IS NOT NULL` —— 不按计划练的那些场次（第一次用 App、
 *   从别处导入的记录）不参与轮转，否则它们会把指针打回第一套；
 * - `rowid DESC` —— `started_at` 只有毫秒精度，同一毫秒的两场会完全并列，
 *   此时 SQLite 按扫描顺序返回（先插入的在前），语义就反了。
 *   这个坑 `setRepo.getLastPerformance` 的注释里已经写过两遍。
 *
 * @param exec SQL 执行器
 * @returns `split_template.id`；**一场这样的训练都没有时返回 null**
 *   （调用方据此从第一套开始）
 */
export async function findLatestTemplateId(
  exec: SqlExecutor,
): Promise<string | null> {
  const row = await exec.first<{ template_id: string | null }>(
    `SELECT template_id FROM session
      WHERE finished_at IS NOT NULL AND template_id IS NOT NULL
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1`,
  );
  return row?.template_id ?? null;
}
```

- [ ] **Step 4: 改 `startNew`**

`src/store/activeSession.ts`：

1. 顶部 import 补 `nextTemplateIndex`（`../domain/rotation`）、`listTemplates` / `getTemplate`（`../repositories/templateRepo`）、`findLatestTemplateId`（`../repositories/sessionRepo`）。

2. `ActiveSessionState` 接口里，把 `startNew` 的声明换成两条：

```ts
  /**
   * 开一场新训练，动作清单按**分化循环**取：轮到最后一套就练那一套。
   *
   * 库里已经有一场进行中的训练时**不新建**，返回 `'conflict'` 并把那一场装进
   * store 交回界面。这是「同时只可能有一场进行中的训练」这条不变量唯一的守门人。
   *
   * @param templateId 指定用哪套计划（界面上的「换一个计划」）；**省略或传
   *   undefined 时按轮转规则自己算**，传 null 表示明确不按计划（复制上一次）
   */
  startNew: (
    exec: SqlExecutor,
    name: string | null,
    templateId?: string | null,
  ) => Promise<StartResult>;
```

3. 把 `startNew` 的实现换成：

```ts
  startNew: async (exec, name, templateId) => {
    // 复用 `resume` 而不是另写一次查询：它会把那一场连动作带组一起装进 store，
    // 界面选「接着练」时直接导航过去就有东西可渲染 —— 只返回一个 id 的话，
    // 记录页会因为 store 里没有 exercises 而误判成「这次训练还没有动作」。
    if (await get().resume(exec)) return 'conflict';

    // 顺序不能反：**先定计划，再建 session**。轮转的输入是「最近一场已结束
    // 训练用的模板」，先建出来的话这一场虽然 finished_at 还是 NULL、不会污染
    // 那个查询，但「先建后定」很容易在后续改动里被误用别的接口把这一场算进去。
    const chosen =
      templateId === undefined ? await resolveNextTemplateId(exec) : templateId;

    const session = await createSession(exec, name, chosen);

    // 有计划就用计划里的动作清单；没有的话维持旧行为，复制上一次**已结束**
    // 训练的动作组合（`listSessions` 只返回已结束的，所以天然不会复制到
    // 一场还在进行中的训练）。第一次用 App 时是空的，由界面的「添加动作」引导。
    const exerciseIds =
      chosen === null
        ? await previousSessionExerciseIds(exec)
        : ((await getTemplate(exec, chosen))?.exercises ?? []).map(
            (item) => item.templateExercise.exerciseId,
          );

    for (const exerciseId of exerciseIds) {
      await addExerciseWithFirstSet(exec, session.id, exerciseId);
    }

    const exercises = await loadExercises(exec, session.id);
    set({ session, exercises, currentIndex: 0, loading: false });
    return 'started';
  },
```

4. 在同一文件里加两个私有辅助函数（放在 `addExerciseWithFirstSet` 附近）：

```ts
/**
 * 按分化循环算出这一场该用哪套计划。
 *
 * 「上一场用的哪套」由 `findLatestTemplateId` 从库里查，规则本身在
 * `domain/rotation.ts` 的纯函数里 —— 那一层负责全部边界（只有一套、绕回
 * 第一套、上一场的计划已被删），这里只做「查 + 算」两件事。
 *
 * @param exec SQL 执行器
 * @returns 计划 id；**一套计划都没有时返回 null**，调用方据此退回
 *   「复制上一次的动作清单」
 */
async function resolveNextTemplateId(exec: SqlExecutor): Promise<string | null> {
  const [templates, lastTemplateId] = await Promise.all([
    listTemplates(exec),
    findLatestTemplateId(exec),
  ]);
  const index = nextTemplateIndex(templates, lastTemplateId);
  return index === null ? null : templates[index].id;
}

/**
 * 「上一次练了哪些动作」—— 没有计划时唯一的动作来源。
 *
 * `listSessions` 只返回**已结束**的训练，所以这里天然不会把一场还在进行中的
 * 训练当成「上一次」。没有历史（第一次用）时返回空数组。
 *
 * @param exec SQL 执行器
 * @returns 动作 id，顺序即上一场里的顺序
 */
async function previousSessionExerciseIds(exec: SqlExecutor): Promise<string[]> {
  const previous = await listSessions(exec, 1);
  if (!previous[0]) return [];
  const sessionExercises = await listSessionExercises(exec, previous[0].id);
  return sessionExercises.map((item) => item.exerciseId);
}
```

5. 加 `startNewWithTemplate`（同一个 store 里，`startNew` 之后）：

```ts
  /**
   * 用指定的计划开一场（首页「换一个计划」用）。
   *
   * 单独开一个方法而不是让界面传第三个参数给 `startNew`：轮转是默认路径，
   * 界面十次里有九次不该关心参数；把「绕开轮转」做成一个名字明确的方法，
   * 调用点一眼看得出这里发生了例外。
   */
  startNewWithTemplate: (exec, name, templateId) =>
    get().startNew(exec, name, templateId),
```

接口里对应加一行声明（`startNewWithTemplate: (exec: SqlExecutor, name: string | null, templateId: string) => Promise<StartResult>;`）。

- [ ] **Step 5: 跑测试，确认绿了**

Run: `npx jest src/store/activeSession.test.ts`
Expected: PASS。原有的「沿用上一次的动作组合」那 4 条**必须仍然绿**——它们全都建立在「库里有已结束训练、没有任何计划」的前提下，走的正是 `chosen === null` 那条分支。

- [ ] **Step 6: 跑全量 + typecheck**

Run: `npx jest; npx tsc --noEmit`
Expected: 全绿、干净。

- [ ] **Step 7: 提交**

```bash
git add src/store/activeSession.ts src/repositories/sessionRepo.ts src/store/activeSession.test.ts
git commit -m "feat(store): 开始训练时按分化循环取计划，无计划则维持旧行为"
```

---

## Task 7: 计划管理界面

**Files:**
- Create: `app/plan/index.tsx`
- Create: `app/plan/[id].tsx`
- Modify: `app/_layout.tsx`（注册两条路由）
- Modify: `app/(tabs)/settings.tsx`（加「训练计划」卡片）

**Interfaces:**
- Consumes: Task 3/4 的 `templateRepo` 全部导出、`listExercises`（`exerciseRepo`）
- Produces: 无（终端界面）

> 这个 Task 没有 jest 测试：jest 的 `testMatch` 只匹配 `src/**/*.test.ts`，且 `testEnvironment` 是 node，渲染不了组件。仓库现有的界面改动也都是「跑 `npx tsc --noEmit` + 真机验收」。**必须**在 Step 4 真机上看一遍。

- [ ] **Step 1: 写计划列表页**

创建 `app/plan/index.tsx`。规范：**颜色只从 `usePalette()` 取、间距只用 `src/ui/tokens` 的 `space`**，样式写成 `useMemo` 包着的 hook（照 `app/(tabs)/history.tsx` 的 `useHistoryStyles`），因为模块级 `StyleSheet.create` 在模块加载时就固化了，拿不到主题。

页面结构：

```
[原生导航栏，标题「训练计划」，右上角「＋」]

  说明文字：开始训练时会按下面的顺序自动轮转。
  老用户先建一套（或几套）计划，之后的每场训练就不必再手动挑动作。

  推日        3 个动作      [↑] [↓] [⋯]
  拉日        4 个动作      [↑] [↓] [⋯]
  腿日        5 个动作      [↑] [↓] [⋯]

  [ ＋ 新建计划 ]
```

要点：
- 用 `useFocusEffect` 在每次进入时重新取 `listTemplates(exec)`（照 `app/(tabs)/history.tsx:102` 的写法）。从编辑页返回后必须看到新顺序，`useEffect` 在页面常驻时不会再跑。
- 点一行 → `router.push({ pathname: '/plan/[id]', params: { id } })`。**必须用对象形式**：typedRoutes 只生成 `/plan/[id]` 这个字面量，模板字符串过不了 tsc。
- 「＋」→ `router.push({ pathname: '/plan/[id]', params: { id: 'new' } })`。
- 上移/下移：`moveTemplate(exec, index, index - 1)` / `moveTemplate(exec, index, index + 1)`，第一个的「↑」和最后一个的「↓」用 `disabled` 态（**不要**让它们消失——按钮位置跳动比灰按钮更烦人）。移动后重新取列表。
- 每行除了「↑」「↓」之外，还有一个行内小按钮「⋯」→ 点开一个 `Modal` 底部弹层（**不用 `Alert`**：Android 上一个 Alert 最多三个按钮，而这里要四件事——重命名、复制、删除、取消。弹层的结构照 `app/session/[id].tsx` 的 `pickerModal`：背景 `Pressable` 关掉 + 底部 sheet）：
  - **重命名**：`Alert.prompt` 在 Android 上不存在，所以把 sheet 就地换成一个输入态——用同一个 `Modal` 里的 `TextInput` + 「保存」/「取消」，`renameTemplate` 后刷新。
  - **复制这一套**：读 `getTemplate` → `createTemplate(name + ' 副本')` → `setTemplateExercises(新 id, 原动作 id 数组)` → 刷新列表。分化计划里「在腿日基础上改出腿日 B」是常见需求，而复制比从零再挑一遍动作快得多。**没有新接口**——两个现成的写入口拼一下就是它，这是「动作清单只有整体覆盖一个写入口」的直接收益。
  - **删除**：确认文案必须说清历史不受影响：`删除「腿日」？用它练过的 N 场训练会保留，只是不再属于这个计划。`（`deleteTemplate` 的返回值里有这个 N。）
- 一个计划都没有时显示空态：「还没有训练计划」+「＋ 新建计划」，并写明「不建也能用，新训练会沿用上一次的动作」。

- [ ] **Step 2: 写计划编辑页**

创建 `app/plan/[id].tsx`，`id === 'new'` 走新建分支（进来先 `createTemplate(exec, '新计划')` 拿到 id，然后 `router.setParams({ id })` 换成真实 id，避免「新建但没保存」留下一个空计划——**注意**：这样一进来库里就有一个空计划了，所以返回时要检查「名字没改过且一个动作都没有」就把它删掉，否则用户点一下「＋」再返回就多一个「新计划」）。

页面结构（本地 state 持有一份可编辑的副本，**保存时才写库**）：

```
[标题「编辑计划」]  [保存]

  名称  [________________]

  1  深蹲                  [↑] [↓] [✕]
  2  卧推                  [↑] [↓] [✕]
  3  飞鸟                  [↑] [↓] [✕]

  [ ＋ 添加动作 ]
```

要点：
- 本地 state：`name: string`、`exerciseIds: string[]`（只存 id，顺序即计划顺序）、外加一份 `id → name` 的映射用来显示（从 `getTemplate` 拿、或加动作时把选中动作的名字塞进去）。
- 「保存」→ `setTemplateExercises(exec, id, exerciseIds)` + `renameTemplate(exec, id, name)` → `router.back()`。名字为空时退回「新计划」。
- **「复制这一套」**（列表页长按菜单里的第三项）：分化计划里「在腿日基础上改出腿日 B」是常见需求，而复制比从零再挑一遍动作快得多。实现就是列表页那一项里读 `getTemplate`、`createTemplate(name + ' 副本')`、`setTemplateExercises(新 id, 原动作 id 数组)` 三步，然后刷新列表。**不需要新接口**——两个现成的写入口拼一下就是它，这也是「动作清单只有整体覆盖一个写入口」这个设计的直接收益。
- 有未保存改动时按返回键要问一句：`Alert.alert('放弃修改？', '改动还没保存。', [{ text: '继续编辑', style: 'cancel' }, { text: '放弃', style: 'destructive', onPress: () => router.back() }])`。
- 加动作的弹层**在这个 Task 里先在本文件内实现一份**（和 `app/session/[id].tsx:294-366` 那个同构：`Modal` + `TextInput` 搜索 + `FlatList` 按肌群分组）。**M8 的 Task 13 会把它抽成共用组件并让这里改用共用版**——先写一份是为了让 M6 能独立验收，不要因为它将来要抽走就现在跨轮次依赖。
- 删除某一行的动作只动本地 state，不写库。

- [ ] **Step 3: 注册路由 + 设置页入口**

`app/_layout.tsx` 的 `Stack` 里加：

```tsx
          {/* 计划列表与编辑：顶部只有标题和保存，交给原生导航栏白拿返回手势 */}
          <Stack.Screen name="plan/index" options={{ title: '训练计划' }} />
          <Stack.Screen name="plan/[id]" options={{ title: '编辑计划' }} />
```

`app/(tabs)/settings.tsx` 在「外观」与「备份」两张卡片之间插入一张「训练计划」卡片：

```tsx
        <Card style={{ gap: space.sm }}>
          <Text variant="title">训练计划</Text>
          <Text variant="caption" color="textMuted">
            编排你的分化循环（推日 / 拉日 / 腿日……），开始训练时会按顺序自动轮转。
          </Text>
          <Button
            label="管理训练计划"
            variant="secondary"
            onPress={() => router.push('/plan')}
            style={{ marginTop: space.sm }}
          />
        </Card>
```

（需要 `import { useRouter } from 'expo-router';` 和 `const router = useRouter();`。）

- [ ] **Step 4: 跑 typecheck 并真机/模拟器验收**

Run: `npx tsc --noEmit`
Expected: 干净。

然后**必须**在设备上走一遍（Metro 起在 `npx expo start`）：

1. 设置 → 管理训练计划 → 建「推日」，加 2 个动作，保存
2. 返回列表能看到「推日 2 个动作」
3. 再建「拉日」，用「↑」把它移到第一位，返回设置再进来，顺序还在
4. 点「拉日」的「⋯」→ 重命名成「拉日 A」→ 列表上名字变了
5. 再点「⋯」→**复制这一套** → 列表多出「拉日 A 副本」，动作清单与原来一样（进去看一遍）
6. 点「⋯」→ 删除「拉日 A 副本」→ 列表只剩两条
7. 进「推日」编辑页，删掉一个动作、加一个动作、改名，保存后返回再看一遍
8. 进编辑页随便改一下，按系统返回键 → 弹「放弃修改？」→ 选「放弃」后列表里的数据**没有**被改

- [ ] **Step 5: 提交**

```bash
git add app/plan app/_layout.tsx "app/(tabs)/settings.tsx"
git commit -m "feat(ui): 训练计划的列表与编辑界面"
```

---

## Task 8: 首页显示今天练什么 + 换计划

**Files:**
- Modify: `app/(tabs)/index.tsx`

**Interfaces:**
- Consumes: Task 6 的 `startNew` / `startNewWithTemplate`、Task 3 `listTemplates` / `getTemplate`、`nextTemplateIndex`（`src/domain/rotation.ts`）、`findLatestTemplateId`（`sessionRepo`）
- Produces: 无（终端界面）

> ⚠️ **不要用 `describeExercises`（`src/lib/sessionLabel.ts`）拼计划卡片上的动作说明。** 那个函数是给「进行中的训练」用的：它会 `filter((set) => set.isCompleted)` 并拼出「· 已记 N 组」，而计划里只有动作名、没有组（传进去会读到 `undefined.isCompleted` 直接抛错）。卡片上就用下面那个模板串手写：`${第一个动作名} 等 N 个动作`。

- [ ] **Step 1: 加「今天该练」的状态与取数**

在 `app/(tabs)/index.tsx` 里加：

```tsx
  // 「今天该练哪套」：默认是轮转算出来的那套，用户可以在弹层里改。
  // **只存在本地 state 里，不落库** —— 用户没点「开始训练」之前什么都没发生，
  // 一旦落库就等于替他记了一个决定；而这一场真正开始时会把选中的 id 写进
  // session.template_id，轮转指针自然跟着走。
  const [plannedId, setPlannedId] = useState<string | null>(null);
  // 计划清单 + 每个计划的动作名，用来在卡片上显示「背 等 6 个动作」
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [plannedNames, setPlannedNames] = useState<string[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
```

取数 effect（只在**没有**进行中的训练时跑，省掉一次查询）：

```tsx
  useEffect(() => {
    if (current) return;
    let cancelled = false;
    void (async () => {
      const [all, lastTemplateId] = await Promise.all([
        listTemplates(exec),
        findLatestTemplateId(exec),
      ]);
      if (cancelled) return;
      const index = nextTemplateIndex(all, lastTemplateId);
      const chosen = index === null ? null : all[index].id;
      setTemplates(all);
      setPlannedId(chosen);
      if (!chosen) {
        setPlannedNames([]);
        return;
      }
      const detail = await getTemplate(exec, chosen);
      if (!cancelled) {
        setPlannedNames(
          (detail?.exercises ?? []).map((item) => item.exerciseName),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [exec, current, refreshKey]);
```

`refreshKey` 是一个 `useState(0)`，从计划弹层里选完或从设置页回来时 `setRefreshKey(k => k + 1)` 触发重算。**注意**：`current` 变化时也要重算（一场训练结束后回来，卡片要显示下一套）。

- [ ] **Step 2: 渲染卡片**

在「开始训练」按钮**上方**插入（只在 `!current && plannedId` 时渲染）：

```tsx
        {!current && plannedId ? (
          <Card>
            <View style={styles.planHeader}>
              <Text variant="label" color="textMuted">
                今天该练
              </Text>
              {/* 「第 2 / 3 套」：没有它的话用户看不出这是一个循环的哪一环，
                  也不知道再练几场会转回来 —— 而这正是「分化循环」这个概念本身 */}
              <Text variant="label" color="textFaint">
                第 {templates.findIndex((t) => t.id === plannedId) + 1} /{' '}
                {templates.length} 套
              </Text>
            </View>
            <Text variant="h2" style={{ marginTop: space.xs }}>
              {templates.find((t) => t.id === plannedId)?.name ?? '计划'}
            </Text>
            <Text variant="caption" color="textMuted" style={{ marginTop: space.xs }}>
              {plannedNames.length > 0
                ? `${plannedNames[0]} 等 ${plannedNames.length} 个动作`
                : '这套计划里还没有动作'}
            </Text>
            <Button
              label="换一个计划"
              variant="ghost"
              onPress={() => setPickerVisible(true)}
              style={{ marginTop: space.sm }}
            />
          </Card>
        ) : null}
```

（`planHeader` 是 `{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }`，按现有文件的样式写法加进那个 `style={{ ... }}` 内联对象里即可 —— `app/(tabs)/index.tsx` 现在全用内联样式，不要为它引入一个 `StyleSheet`。）
```

主按钮的 `onPress` 改成按 `plannedId` 走：

```tsx
  const handleStart = useCallback(async () => {
    const result = plannedId
      ? await startNewWithTemplate(exec, null, plannedId)
      : await startNew(exec, null);
    // …以下错误处理与冲突弹窗逻辑一个字都不动（见现有实现）
  }, [/* 现有依赖 */ plannedId, startNewWithTemplate]);
```

> **不要把 `plannedId` 直接塞给 `startNew` 的第三个参数**：`startNew` 的 `undefined` 表示「按轮转算」，传错会让轮转永远失效。用 `startNewWithTemplate` 这条名字明确的路，出问题时一眼看得出是谁绕开了轮转。

没建过任何计划时（`plannedId === null`）：卡片整个不渲染，**现有的那句提示文案「会沿用上次的动作清单，直接接着练」保持原样**——老用户升级上来看到的界面不变。

- [ ] **Step 3: 换计划的弹层**

用 `Modal`（`Alert` 只支持三个按钮，套数不定）。列出全部计划，当前选中的打勾：

```tsx
      <Modal visible={pickerVisible} transparent animationType="slide" onRequestClose={() => setPickerVisible(false)}>
        {/* 结构照 app/session/[id].tsx 的 pickerModal：背景 Pressable 关掉 + 底部 sheet */}
        {templates.map((t) => (
          <Pressable
            key={t.id}
            style={styles.option}
            onPress={() => {
              setPlannedId(t.id);
              setPickerVisible(false);
            }}
          >
            <Text variant="body">{t.name}</Text>
            <Text variant="caption" color="textMuted">
              {t.exerciseCount} 个动作{t.id === plannedId ? ' · 已选' : ''}
            </Text>
          </Pressable>
        ))}
        <Button label="去编排计划" variant="ghost" onPress={() => { setPickerVisible(false); router.push('/plan'); }} />
      </Modal>
```

弹层里的说明写一句：`选了就是这一场练它；下一场还是按顺序轮转。`

- [ ] **Step 4: 真机验收**

Run: `npx tsc --noEmit` 然后上设备：

1. 建「推/拉/腿」三套计划 → 首页卡片显示「今天该练 推日」
2. 开始训练 → 记录页的动作清单就是推日那套 → 结束训练 → 回首页
3. 首页显示「今天该练 拉日」；连做三场后回到推日
4. 首页点「换一个计划」选「腿日」→ 开始训练 → 动作清单是腿日那套 → 结束 → 首页显示「今天该练 推日」（因为腿日后面轮到推日）
5. 删掉全部计划 → 首页回到「会沿用上次的动作清单」那句，卡片消失

- [ ] **Step 5: 提交**

```bash
git add "app/(tabs)/index.tsx"
git commit -m "feat(home): 首页显示今天该练哪套计划，可直接换计划开练"
```

---

# M7 · 删除

## Task 9: `sessionRepo` 的三个删除

**Files:**
- Modify: `src/repositories/sessionRepo.ts`
- Test: `src/repositories/sessionRepo.test.ts`（追加）

**Interfaces:**
- Produces:
  - `deleteSession(exec, id: string): Promise<void>`
  - `deleteSessionExercise(exec, sessionExerciseId: string): Promise<number>`（返回被删掉多少组）
  - `deleteIncompleteSetsOf(exec, sessionExerciseId: string): Promise<number>`（返回删掉了几条占位组）

- [ ] **Step 1: 写失败的测试**

在 `src/repositories/sessionRepo.test.ts` 末尾追加（import 按需补 `deleteSession, deleteSessionExercise, deleteIncompleteSetsOf, getActiveSession`、`addSet, completeSet, listSets`、`createCustomExercise`）：

```ts
describe('删除训练记录', () => {
  /** 造一场「2 个动作、每个动作 2 组已完成」的训练，返回各个 id */
  async function setupSessionWithSets(exec: SqlExecutor) {
    const session = await createSession(exec, '腿部日', null);
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const bench = await createCustomExercise(exec, '卧推', '胸', '杠铃');
    const seSquat = await addExerciseToSession(exec, session.id, squat.id);
    const seBench = await addExerciseToSession(exec, session.id, bench.id);

    for (const se of [seSquat, seBench]) {
      for (const weight of [100, 105]) {
        const set = await addSet(exec, se.id, weight, 5);
        await completeSet(exec, set.id, Date.now());
      }
    }
    await finishSession(exec, session.id, Date.now());
    return { session, seSquat, seBench };
  }

  it('删一场训练，它的动作与组一起消失（靠外键级联）', async () => {
    const exec = await createMigratedExecutor();
    const { session, seSquat } = await setupSessionWithSets(exec);

    await deleteSession(exec, session.id);

    expect(await getSession(exec, session.id)).toBeNull();
    expect(await listSessionExercises(exec, session.id)).toEqual([]);
    expect(await listSets(exec, seSquat.id)).toEqual([]);
    // 动作库本身不能被牵连
    expect(await listExercises(exec)).toHaveLength(2);
  });

  it('只删掉目标那一场，别的场次一组不少', async () => {
    const exec = await createMigratedExecutor();
    const first = await setupSessionWithSets(exec);
    const second = await setupSessionWithSets(exec);

    await deleteSession(exec, first.session.id);

    expect(await getSession(exec, second.session.id)).not.toBeNull();
    expect(await listSets(exec, second.seSquat.id)).toHaveLength(2);
  });

  it('删掉进行中的那一场之后，getActiveSession 返回 null', async () => {
    const exec = await createMigratedExecutor();
    // 进行中的那一场：不调 finishSession
    const session = await createSession(exec, '没结束的训练', null);
    expect(await getActiveSession(exec)).not.toBeNull();

    await deleteSession(exec, session.id);

    // 首页的「继续训练」就是看这个查询的返回值；不清干净的话它会指向
    // 一条已经不存在的记录，点进去是一屏空白
    expect(await getActiveSession(exec)).toBeNull();
  });

  it('deleteSessionExercise 把组和动作一起删掉，并重排后面的 position', async () => {
    const exec = await createMigratedExecutor();
    const { session, seSquat } = await setupSessionWithSets(exec);

    const removedSets = await deleteSessionExercise(exec, seSquat.id);

    expect(removedSets).toBe(2);
    expect(await listSets(exec, seSquat.id)).toEqual([]);
    const remaining = await listSessionExercises(exec, session.id);
    expect(remaining).toHaveLength(1);
    // 剩下的那个原本是 position 1，删掉 0 之后必须变成 0。
    // 留着空洞 order by 也还能用，但以后要插到中间就会错位。
    expect(remaining[0].position).toBe(0);
  });

  it('deleteIncompleteSetsOf 删掉占位组、留下已完成的组，动作这一条还在', async () => {
    const exec = await createMigratedExecutor();
    const { session, seSquat } = await setupSessionWithSets(exec);
    // `setupSessionWithSets` 造的都是已完成的组，先补一条占位组进去
    // —— 真实流程里 `completeCurrentSet` 每完成一组都会预建一条
    await addSet(exec, seSquat.id, 105, 5);

    const removed = await deleteIncompleteSetsOf(exec, seSquat.id);

    expect(removed).toBe(1);
    const remaining = await listSets(exec, seSquat.id);
    // 练过的 2 组必须还在：进步曲线只认已完成且属于某场训练的组，
    // 用户选的是「别删我的记录」，不是「抹掉历史」
    expect(remaining).toHaveLength(2);
    expect(remaining.every((s) => s.isCompleted)).toBe(true);
    // 动作还在，position 也不动 —— 界面靠「这个动作的 sets 为空」把它摘掉
    expect((await listSessionExercises(exec, session.id)).map((se) => se.id)).toContain(
      seSquat.id,
    );
  });
});
```

- [ ] **Step 2: 跑测试，确认它是红的**

Run: `npx jest src/repositories/sessionRepo.test.ts`
Expected: FAIL —— `deleteSession is not a function`。

- [ ] **Step 3: 实现**

在 `src/repositories/sessionRepo.ts` 末尾追加：

```ts
/**
 * 删掉一场训练。**不可恢复。**
 *
 * 只写一句 `DELETE FROM session`：两个子表的删除由外键的 `ON DELETE CASCADE`
 * 负责（建表时就写了，`repositories/database.tsx` 每次打开连接都开
 * `PRAGMA foreign_keys = ON`）。手写三句 DELETE 只会多一份可能与外键不一致的
 * 逻辑。
 *
 * ⚠️ **绝不要写成 `DELETE FROM session WHERE id <> ?` 或带 `NOT IN` 子查询的形式。**
 * 开着外键时 SQLite 会对 `session` 的删除级联扫 `session_exercise`，而这条
 * DELETE 自己正在读 `session_exercise` → 报 `database table is locked`。
 * 按单个 id 删不经过子查询，是安全的。
 *
 * @param exec SQL 执行器
 * @param id 要删的训练
 * @returns 删除完成后 resolve。**id 不存在时也正常返回**（幂等，不抛错）
 */
export async function deleteSession(
  exec: SqlExecutor,
  id: string,
): Promise<void> {
  await exec.run('DELETE FROM session WHERE id = ?', [id]);
}

/**
 * 从一场训练里去掉一个动作，连同它已经记下的组。
 *
 * 顺序不能改：先删组再删动作。反过来（靠动作的级联删组）在开着外键时同样会
 * 触发「正在删父行、又要扫子表」的问题；显式先删子表最省事也最好读。
 *
 * 最后一句重排 `position`：被删掉的动作后面的那些整体前移一位，不留空洞。
 * 空洞本身不会让 `ORDER BY position` 出错，但以后要把动作插到中间（拖拽排序）
 * 就会错位 —— 是个埋着的坑。
 *
 * @param exec SQL 执行器
 * @param sessionExerciseId 要删掉的 `session_exercise.id`
 * @returns 一起删掉了多少组（界面在二次确认的文案里要说清这个数）
 */
export async function deleteSessionExercise(
  exec: SqlExecutor,
  sessionExerciseId: string,
): Promise<number> {
  const target = await exec.first<{ session_id: string; position: number }>(
    'SELECT session_id, position FROM session_exercise WHERE id = ?',
    [sessionExerciseId],
  );
  if (!target) return 0;

  const countRow = await exec.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM set_entry WHERE session_exercise_id = ?',
    [sessionExerciseId],
  );

  await exec.run('BEGIN');
  try {
    await exec.run('DELETE FROM set_entry WHERE session_exercise_id = ?', [
      sessionExerciseId,
    ]);
    await exec.run('DELETE FROM session_exercise WHERE id = ?', [
      sessionExerciseId,
    ]);
    await exec.run(
      'UPDATE session_exercise SET position = position - 1 WHERE session_id = ? AND position > ?',
      [target.session_id, target.position],
    ]);
    await exec.run('COMMIT');
  } catch (error) {
    // 回滚自身也可能抛，调用方更需要知道「为什么失败」，所以吞掉回滚的异常
    try {
      await exec.run('ROLLBACK');
    } catch {
      // 忽略：下面抛原始异常
    }
    throw error;
  }

  return Number(countRow?.n ?? 0);
}

/**
 * 只删掉一个动作下**还没完成的**占位组，已完成的组与动作本身都留着。
 *
 * 用于「这个动作我不想在这一场里继续练了，但**别删我练过的记录**」这条路径：
 * - 已完成的组留在库里 → 进步曲线的点还在（曲线只认 `is_completed = 1`）；
 * - 未完成的占位组删掉 → 这个动作的 `sets` 变成空数组，界面的
 *   「有动作才显示」判断会把它从记录页摘掉，而用户下次 `resume` 这一场时
 *   它也不会带着一条孤儿占位组冒出来（`completeCurrentSet` 找不到待完成的组
 *   会静默 return —— 那就是一个点了没反应的假死按钮）。
 *
 * **必须删掉占位组**：`completeCurrentSet` 每完成一组都会预建下一组，只删动作
 * 不删组的话，这条占位组会永远留在库里，而它既不是训练量、也永远不会被完成。
 *
 * @param exec SQL 执行器
 * @param sessionExerciseId 目标动作
 * @returns 删掉了多少条占位组
 */
export async function deleteIncompleteSetsOf(
  exec: SqlExecutor,
  sessionExerciseId: string,
): Promise<number> {
  const countRow = await exec.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM set_entry WHERE session_exercise_id = ? AND is_completed = 0',
    [sessionExerciseId],
  );
  await exec.run(
    'DELETE FROM set_entry WHERE session_exercise_id = ? AND is_completed = 0',
    [sessionExerciseId],
  );
  return Number(countRow?.n ?? 0);
}
```

- [ ] **Step 4: 跑测试，确认绿了**

Run: `npx jest src/repositories/sessionRepo.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/repositories/sessionRepo.ts src/repositories/sessionRepo.test.ts
git commit -m "feat(repo): 删训练、删训练里的动作（含 position 重排）"
```

---

## Task 10: store 的 `removeExercise`

**Files:**
- Modify: `src/store/activeSession.ts`
- Test: `src/store/activeSession.test.ts`（追加）

**Interfaces:**
- Consumes: Task 9 的三个删除函数
- Produces: `removeExercise(exec, sessionExerciseId: string, mode: 'delete' | 'keep'): Promise<void>`

- [ ] **Step 1: 写失败的测试**

在 `src/store/activeSession.test.ts` 末尾追加：

```ts
describe('训练中删动作', () => {
  beforeEach(() => {
    useActiveSession.getState().reset();
  });

  /** 开一场训练并加两个动作，A 做完 2 组、B 一组没做 */
  async function setupTwoExercises(exec: SqlExecutor) {
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const bench = await createCustomExercise(exec, '卧推', '胸', '杠铃');
    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().addExercise(exec, squat.id);
    await useActiveSession.getState().completeCurrentSet(exec, 100, 5);
    await useActiveSession.getState().completeCurrentSet(exec, 100, 5);
    await useActiveSession.getState().addExercise(exec, bench.id);
    return {
      sessionId: useActiveSession.getState().session!.id,
      squatSe: useActiveSession.getState().exercises[0].sessionExercise.id,
      benchSe: useActiveSession.getState().exercises[1].sessionExercise.id,
    };
  }

  it("mode: 'delete' 把动作和它的组一起删掉，清单里不再有它", async () => {
    const exec = await createMigratedExecutor();
    const { squatSe, benchSe } = await setupTwoExercises(exec);

    await useActiveSession.getState().removeExercise(exec, squatSe, 'delete');

    const { exercises } = useActiveSession.getState();
    expect(exercises.map((e) => e.exerciseName)).toEqual(['卧推']);
    expect(exercises[0].sessionExercise.id).toBe(benchSe);
    expect(await listSets(exec, squatSe)).toEqual([]);
  });

  it("mode: 'keep' 时动作从记录页消失，但练过的组留在库里", async () => {
    const exec = await createMigratedExecutor();
    const { squatSe } = await setupTwoExercises(exec);

    await useActiveSession.getState().removeExercise(exec, squatSe, 'keep');

    expect(useActiveSession.getState().exercises.map((e) => e.exerciseName)).toEqual([
      '卧推',
    ]);
    // 「先留着」= 练过的 2 组留在库里（进步曲线的点还在），
    // 未完成的占位组被删掉（否则这个动作的 sets 不为空，界面不会摘掉它，
    // 下次 resume 还会带着一个点不动的「完成这组」回来）
    const remaining = await listSets(exec, squatSe);
    expect(remaining).toHaveLength(2);
    expect(remaining.every((s) => s.isCompleted)).toBe(true);
  });

  it('删掉的正好是当前聚焦的动作时，currentIndex 被夹住而不是越界', async () => {
    const exec = await createMigratedExecutor();
    const { squatSe } = await setupTwoExercises(exec);
    // 当前停在第二个动作（卧推）上
    expect(useActiveSession.getState().currentIndex).toBe(1);

    await useActiveSession.getState().removeExercise(exec, squatSe, 'delete');

    const { exercises, currentIndex } = useActiveSession.getState();
    // 删掉第一个之后卧推变成第 0 个，指针必须跟着回到合法范围。
    // 不夹的话 exercises[1] 是 undefined，记录页会掉进
    // 「这次训练还没有动作」而库里其实还有动作 —— 比崩溃更难查。
    expect(currentIndex).toBe(0);
    expect(exercises[currentIndex]).toBeDefined();
    expect(exercises[currentIndex].exerciseName).toBe('卧推');
  });

  it('删光最后一个动作时，currentIndex 归 0 且清单为空', async () => {
    const exec = await createMigratedExecutor();
    const squat = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    await useActiveSession.getState().startNew(exec, null);
    await useActiveSession.getState().addExercise(exec, squat.id);
    const se = useActiveSession.getState().exercises[0].sessionExercise.id;

    await useActiveSession.getState().removeExercise(exec, se, 'delete');

    expect(useActiveSession.getState().exercises).toEqual([]);
    expect(useActiveSession.getState().currentIndex).toBe(0);
  });

  it('已结束的训练不接受删动作（防御闸门）', async () => {
    const exec = await createMigratedExecutor();
    const { sessionId, squatSe } = await setupTwoExercises(exec);
    await useActiveSession.getState().endWorkout(exec);

    // 模拟「有人绕过状态机，把一场已结束的训练塞回 store」
    const finished = await getSession(exec, sessionId);
    useActiveSession.setState({ session: finished });
    await useActiveSession.getState().removeExercise(exec, squatSe, 'delete');

    // 库里那个动作必须还在
    expect((await listSessionExercises(exec, sessionId)).map((se) => se.id)).toContain(
      squatSe,
    );
  });
});
```

- [ ] **Step 2: 跑测试，确认它是红的**

Run: `npx jest src/store/activeSession.test.ts`
Expected: FAIL —— `removeExercise is not a function`。

- [ ] **Step 3: 实现**

`src/store/activeSession.ts`：

1. import 补 `deleteIncompleteSetsOf, deleteSessionExercise`。
2. 接口里加声明：

```ts
  /**
   * 从这一场训练里去掉一个动作。
   *
   * @param exec SQL 执行器
   * @param sessionExerciseId 要删掉的 `session_exercise.id`（**不是 exerciseId**）
   * @param mode `'delete'` = 连它已经记下的组一起删；`'keep'` = 只把动作从这一场
   *   摘掉，组留在库里（进步曲线仍然有那些点）
   */
  removeExercise: (
    exec: SqlExecutor,
    sessionExerciseId: string,
    mode: 'delete' | 'keep',
  ) => Promise<void>;
```

3. 实现（放在 `addExercise` 之后）：

```ts
  removeExercise: async (exec, sessionExerciseId, mode) => {
    const { session, currentIndex } = get();
    // 已结束的训练不能再改。正常路径下 `endWorkout` 已经清空 store、
    // session 为 null，这里挡的是「有人把一场已结束的训练塞回 store」。
    if (!session || session.finishedAt !== null) return;

    if (mode === 'delete') {
      await deleteSessionExercise(exec, sessionExerciseId);
    } else {
      await deleteIncompleteSetsOf(exec, sessionExerciseId);
    }

    const loaded = await loadExercises(exec, session.id);
    // `mode: 'keep'` 时动作那一行还在库里，`loadExercises` 照样把它读回来，
    // 所以这里要**按「它还有没有未完成的组」再筛一次** —— 用户点「先留着」的意思是
    // 「这一场别再让我看见它」，只删占位组、不筛的话动作会原地不动。
    //
    // 判据不是「id 等于被删的那个」：写成 id 比较的话，我们是在用一个内存里的
    // 假设代替库里的**事实**，也就会出现「内存说摘掉了、库里其实还有占位组」
    // 这种不一致。
    //
    // 也不能用 `sets.length > 0`（「一行 set 都没有」）：`mode: 'keep'` 只删占位组、
    // 保留练过的组，所以被摘掉的动作在库里不是「没有组」，而是「没有还没完成的组」。
    // 按后者判，`keep` 之后它正好落选；按前者判，它会带着刚留下的已完成组原地不动
    // （实测：深蹲 2 条已完成组、0 条待完成，`sets.length > 0` 仍然成立）。
    //
    // 而且这个判据与记录页**本来就是同一个**：`addExerciseWithFirstSet` 预建第一组、
    // `completeCurrentSet` 完成后立刻预建下一组，所以「还有未完成的组」正是记录页
    // 能记下一组的条件（找不到待完成的组，那个「完成这组」按钮就是个假死按钮）。
    // 用同一条判据，才不会出现「动作条里有它、屏幕上却记不了」的状态。
    const visible = loaded.filter((item) =>
      item.sets.some((s) => !s.isCompleted),
    );

    // 指针必须夹回合法范围：删掉的正好是当前聚焦的那个动作时，
    // `exercises[currentIndex]` 会变成 undefined，记录页掉进「这次训练还没有动作」，
    // 而库里其实还有别的动作 —— 这种「动作条与屏幕内容对不上」比崩溃更难查。
    const nextIndex =
      visible.length === 0 ? 0 : Math.min(currentIndex, visible.length - 1);

    set({ exercises: visible, currentIndex: nextIndex });
  },
```

- [ ] **Step 4: 跑测试，确认绿了**

Run: `npx jest src/store/activeSession.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/store/activeSession.ts src/store/activeSession.test.ts
git commit -m "feat(store): 训练中删动作（删组 / 先留着两条分支）"
```

---

## Task 11: 记录页的删除入口

**Files:**
- Modify: `app/session/[id].tsx`

**Interfaces:**
- Consumes: Task 10 的 `removeExercise`
- Produces: 无（终端界面）

> 没有 jest 测试（组件渲染不在当前配置范围内），Step 3 的真机验收是必做项。

- [ ] **Step 1: 加处理函数**

在 `app/session/[id].tsx` 里，`handleComplete` 之前插入：

```tsx
  /**
   * 删掉当前正在记录的这个动作。
   *
   * 两条分支由「有没有已完成的组」决定，不是由用户选：
   * - 一组都没完成（刚加错、想换一个）→ 直接删，不打扰；
   * - 已经记过组 → 必须问一句，而且要说清**删几组**，因为「删除这个动作」
   *   这五个字看不出会把已经练的组也带走。
   *
   * 三个按钮正好是 Android Alert 的上限（第四个会被静默丢掉）。
   *
   * @returns 无返回值。Alert 是异步的，真正的删除在按钮回调里
   */
  const handleRemoveExercise = () => {
    if (!current) return;
    const completed = current.sets.filter((s) => s.isCompleted).length;

    if (completed === 0) {
      void (async () => {
        try {
          await removeExercise(exec, current.sessionExercise.id, 'delete');
        } catch (e) {
          Alert.alert('没能删掉这个动作', e instanceof Error ? e.message : String(e));
        }
      })();
      return;
    }

    Alert.alert(
      `「${current.exerciseName}」已经记了 ${completed} 组`,
      '把它从这次训练里去掉？',
      [
        {
          text: `删掉这 ${completed} 组`,
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await removeExercise(exec, current.sessionExercise.id, 'delete');
              } catch (e) {
                Alert.alert('没能删掉', e instanceof Error ? e.message : String(e));
              }
            })();
          },
        },
        {
          text: '先留着',
          onPress: () => {
            void (async () => {
              try {
                await removeExercise(exec, current.sessionExercise.id, 'keep');
              } catch (e) {
                Alert.alert('没能移出这个动作', e instanceof Error ? e.message : String(e));
              }
            })();
          },
        },
        { text: '取消', style: 'cancel' },
      ],
    );
  };
```

同时在顶部那个 `useActiveSession()` 解构里加 `removeExercise`。

- [ ] **Step 2: 加按钮**

在动作条（`styles.chipBarWrapper` 那个 `View`）**之后**插入，`exercises.length > 1` 才渲染：

```tsx
      {exercises.length > 1 ? (
        <Pressable
          onPress={handleRemoveExercise}
          accessibilityRole="button"
          accessibilityLabel={`删除动作：${current?.exerciseName ?? ''}`}
          style={styles.removeRow}
        >
          <Text variant="caption" style={styles.removeText}>
            删除「{current?.exerciseName}」
          </Text>
        </Pressable>
      ) : null}
```

样式（加进 `useSessionStyles` 的返回对象）：

```ts
      // 「删除这个动作」：低频、代价高，所以做成一行小字而不是按钮。
      // 它和下面的「结束训练」一样属于「别乱点」的那一类，不跟主按钮抢注意力。
      removeRow: { alignSelf: 'center' as const, paddingVertical: space.xs },
      removeText: { color: palette.danger, textDecorationLine: 'underline' as const },
```

- [ ] **Step 3: 真机验收（必做）**

Run: `npx tsc --noEmit` 然后上设备：

1. 开一场训练，加一个动作、记 2 组，再加一个动作 → 顶部出现「删除「第二个动作名」」
2. 删第二个（没记过组）→ 不弹窗，立刻消失
3. 删第一个（记过 2 组）→ 弹窗写「已经记了 2 组」→ 选「删掉这 2 组」→ 动作消失，且**剩下的动作还能正常记录**（点「完成这组」有反应）
4. 同样场景选「先留着」→ 动作从屏幕上消失，去历史里看这场训练，那个动作的 2 组还在
5. **当前停在第二个动作上，去删第一个** → 停在剩下的那个动作上，屏幕**不能**显示「这次训练还没有动作」
6. 只留一个动作时，「删除」那行不显示
7. **从空态能加回动作**：开一场没有任何计划的训练（库里没有任何计划时，`startNew` 得到的就是空训练）→ 落到「这次训练还没有动作」空态 → 点「＋ 添加动作」能加进来、能正常记录

> **第 7 条原本写的是「删到只剩一个动作，再删那一个」。那是错的**（实施时被发现）：
> 这一行只在 `exercises.length > 1` 时渲染，而删除永远只作用于当前那一个动作，
> 所以 2→1 可以、**1→0 没有入口** —— 第 6 条正好把它关掉了。两条验收项自相矛盾，
> 而 spec §6.2 站在第 6 条这边（「避免把最后一项删成空屏」）。
> 空态本身是通的（`!current` 分支会渲染「这次训练还没有动作」+「＋ 添加动作」），
> 只是到达它的路径不是「删最后一个动作」，而是「开一场没有动作的训练」。
> **代码按第 6 条（`exercises.length > 1`）保持不变**，改的是这条验收项的措辞。

- [ ] **Step 4: 提交**

```bash
git add "app/session/[id].tsx"
git commit -m "feat(session): 训练中可以删动作，记过组时问一句"
```

---

## Task 12: 历史里删记录

**Files:**
- Modify: `app/(tabs)/history.tsx`
- Modify: `app/history/[id].tsx`

**Interfaces:**
- Consumes: Task 9 的 `deleteSession`
- Produces: 无（终端界面）

- [ ] **Step 1: 历史列表每行加删除入口**

**用行内按钮，不用左滑。** 理由要写在代码里（这是一个刻意的偏离）：`src/components/DragNumber.tsx:64` 的注释已经写明——**根布局没有包 `GestureHandlerRootView`，直接用手势库会在真机上崩**。左滑要么得引入这个全局包裹（会影响已按 PanResponder 调好的拖数字交互），要么得为预览另写一套。列表行的操作用一个常驻的小按钮就够，代价只是不够时髦。

在 `app/(tabs)/history.tsx` 的 `renderItem` 里，`<Text variant="title">` 所在的那个 `View` 后面加：

```tsx
        <Pressable
          onPress={() => confirmDelete(item)}
          accessibilityRole="button"
          accessibilityLabel={`删除 ${item.name ?? '未命名训练'}`}
          hitSlop={12}
          style={styles.deleteButton}
        >
          <Text variant="caption" style={styles.deleteText}>
            删除
          </Text>
        </Pressable>
```

处理函数（放在 `load` 之后）：

```tsx
  /**
   * 删一条训练记录。文案由 `deleteSessionConfirmText` 给出，**列表页与详情页
   * 共用同一份** —— 「删除」两个字看不出会连带删掉组与曲线上的点。
   *
   * @param item 要删的那一场摘要
   * @returns 无返回值。Alert 是异步的，真正的删除在按钮回调里
   */
  const confirmDelete = useCallback(
    (item: SessionSummary) => {
      const { title, message } = deleteSessionConfirmText(
        item.startedAt,
        item.setCount,
      );
      Alert.alert(title, message, [
          { text: '取消', style: 'cancel' },
          {
            text: '删除',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  await deleteSession(exec, item.id);
                  // 删的正好是进行中的那一场时，内存里那条也要清掉，
                  // 否则首页「继续训练」会指向一条已经不存在的记录，
                  // 点进去是一屏空白。清掉之后首页会自己去库里重新 resume。
                  if (useActiveSession.getState().session?.id === item.id) {
                    useActiveSession.getState().reset();
                  }
                  await load();
                } catch (e) {
                  Alert.alert('没能删掉这条记录', e instanceof Error ? e.message : String(e));
                }
              })();
            },
          },
        ],
      );
    },
    [exec, load],
  );
```

样式加进 `useHistoryStyles`：

```ts
      deleteButton: { paddingHorizontal: space.sm, paddingVertical: space.xs },
      deleteText: { color: palette.danger, fontWeight: '600' as const },
```

> `style` 里的 `fontWeight` 类型在 RN 0.86 下用 `'600' as const` 才过 tsc（`Text` 组件的 `style` 收 `StyleProp<TextStyle>`，字面量会被推成 `string`）。`app/(tabs)/settings.tsx:160` 里已经有同样的写法，照抄。

- [ ] **Step 2: 详情页加删除按钮**

`app/history/[id].tsx`：`SessionSummaryView` 之后加一个 `danger` 按钮（只有 `session` 非空时渲染），确认文案与列表一致，删除成功后 `router.back()`。这段逻辑与列表页那份是**同一个文案、不同的触发点**——把文案抽成 `src/lib/deleteConfirm.ts` 里的一个纯函数，两处共用。

顺便加一个不带星期的日期格式：`src/lib/format.ts` 现有的 `formatDate` 返回 `9月16日 周三`，把星期塞进「删除 9月16日 周三 的训练？」这句里读着别扭。加一个：

```ts
/**
 * `2024年1月15日`。用于**确认框**这类需要一眼看清是哪一天的场合。
 *
 * 与 `formatDate`（`9月16日 周三`）的分工：那个用在中/英文混排的列表行里，
 * 星期帮用户对上「我周三练的」这段记忆；而确认框里用户要确认的是「删的是不是
 * 这一场」，星期既不提供信息、又把句子撑长。带年份是因为删除列表里可能有
 * 去年的记录，那时候「9月16日」是歧义的。
 *
 * @param timestamp 毫秒时间戳
 * @returns 形如 `2024年1月15日`
 */
export function formatDateFull(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
```

`src/lib/deleteConfirm.ts`：

```ts
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
```

**顺手清掉一份重复实现**：`app/history/[id].tsx:25-30` 有一份私有的 `formatDate`，内容和 `src/lib/format.ts` 里那个**一模一样**（都是 `9月16日 周三`）。把它删掉、改成从 `src/lib/format.ts` import——两处同样的输出却有两份代码，是那种「改了一处忘了另一处」的经典起点。（`app/(tabs)/history.tsx` 在 `2026-09-21` 那份设计里已经改成 import 了，现在只剩详情页这一份遗留。）

- [ ] **Step 3: 真机验收**

Run: `npx tsc --noEmit` 然后上设备：

1. 历史列表每行右侧有「删除」→ 点一条 → 弹窗文案带日期与组数 → 确认 → 列表少一条
2. 去进步页看：那个动作的曲线上少一个点（如果这场的数据本来是最后一个点，末值会变成前一次）
3. 详情页底部的「删除这条记录」→ 同样流程 → 删完自动回列表
4. **造一场进行中的训练**（开始训练后划掉 App）→ **历史列表里看不到它**（这不是「列表没刷新」，是刻意的：`listSessionSummaries` 带 `WHERE s.finished_at IS NOT NULL`，进行中的训练本来就不进历史）→ 所以这条路径**只能从详情页走**：用深链 `gymtracker://history/<id>` 打开那一场（`getSession` 不带 `finished_at` 过滤，未结束的也会渲染并给出删除按钮）→ 删掉它之后回首页，**「继续训练」必须消失**
   > 列表页那份 `useActiveSession.getState().reset()` 守卫因此是**防御性**的：从列表里到不了进行中的那一场。两处都写上不浪费 —— 它是「删掉当前训练后 store 必须跟着清」这条不变量的唯一落点，将来历史列表若改成也列进行中的训练，它立刻就是必需的。
5. 删掉一场之后，另一场的详情页数据仍然完整

- [ ] **Step 4: 提交**

```bash
git add "app/(tabs)/history.tsx" "app/history/[id].tsx" src/lib/deleteConfirm.ts
git commit -m "feat(history): 列表与详情页都能删训练记录（二次确认写明后果）"
```

---

# M8 · 导入

## Task 13: 抽出共用的动作选择弹层

**Files:**
- Create: `src/components/ExercisePickerModal.tsx`
- Modify: `app/session/[id].tsx`（改用共用组件，删掉本地那份）

**Interfaces:**
- Consumes: `listExercises`（`exerciseRepo`）、`Exercise`（`domain/types`）
- Produces: `ExercisePickerModal` 组件，props：`{ visible: boolean; onClose: () => void; onPick: (exercise: Exercise) => void }`

- [ ] **Step 1: 抽出组件**

把 `app/session/[id].tsx:294-366` 的 `pickerModal`、以及它依赖的 `groupByMuscleGroup`（`:56-68`）、`UNGROUPED_LABEL`、`ExerciseGroup`、样式里的 `modalRoot / modalBackdrop / sheet / sheetHeader / sheetTitle / sheetCancel / sheetCancelText / search / groupTitle / option / optionText / emptyHint`，整体搬到 `src/components/ExercisePickerModal.tsx`。

组件自己管三件事（原来是页面管的）：`allExercises` 的取数、`query` 搜索词、以及按肌群分组。页面只保留 `visible` / `onClose` / `onPick`。

```tsx
/**
 * 选择动作的弹层。记录页、计划编辑页、手动补记录页三处共用。
 *
 * **抽出来的理由不是「少写代码」，而是「只有一份实现」**：这个弹层里有三条
 * 容易写错的约定——动作库只在打开时读一次、搜索按「包含」而不是「前缀」、
 * 肌群分组不能重排仓储给的顺序。三处各写一遍，迟早有一处漏掉其中一条，
 * 而症状是「某个页面里的动作列表莫名其妙少了几项」。
 *
 * @param props.visible 是否显示
 * @param props.onClose 关闭回调（背景、取消、Android 返回键三条路都汇到它）
 * @param props.onPick 选中一个动作。**加失败时调用方不要关弹层** ——
 *   关掉只会让用户以为加上了，对着同一屏反复点
 * @returns 底部弹出的动作列表
 */
export function ExercisePickerModal({ visible, onClose, onPick }: ExercisePickerModalProps) {
```

组件的样式用 `usePalette()` + `useMemo`（照原文件 `useSessionStyles` 的写法），因为颜色来自主题。

- [ ] **Step 2: 让记录页改用共用组件**

`app/session/[id].tsx` 里删掉搬走的那一大段，改成：

```tsx
  const pickerModal = (
    <ExercisePickerModal
      visible={pickerVisible}
      onClose={closePicker}
      onPick={(exercise) => {
        void handlePickExercise(exercise);
      }}
    />
  );
```

`handlePickExercise` 保持现在的行为全都不动（失败时 `Alert` 且**不关弹层**）。

- [ ] **Step 3: 验证**

Run: `npx tsc --noEmit; npx jest`
Expected: tsc 干净、jest 全绿（这一步不该动到任何测试）。

真机走一遍：记录页点「＋」→ 搜索、选动作、空结果提示、Android 返回键关掉弹层、加一个已经在库里的动作。行为必须与改动前完全一样。

- [ ] **Step 4: 提交**

```bash
git add src/components/ExercisePickerModal.tsx "app/session/[id].tsx"
git commit -m "refactor(ui): 动作选择弹层抽成共用组件"
```

---

## Task 14: CSV 解析（纯函数）

**Files:**
- Create: `src/domain/csv.ts`
- Test: `src/domain/csv.test.ts`

**Interfaces:**
- Consumes: `ImportedWorkout`（**Task 15 才会定义它** —— 见下面 Step 3 的说明，这个 Task 里先定义在 `csv.ts` 里并在 Task 15 搬到 `importRecords.ts`）

> **顺序问题**：`ImportedWorkout` 是 CSV 解析的产物，也是落库的输入，两个 Task 都要它。放在 `domain/importRecords.ts`（Task 15）更合理，但那样 Task 14 就没法独立编译。**做法**：Task 14 在 `csv.ts` 里定义并 **export** 它；Task 15 新建 `importRecords.ts` 时**从这里 import 再 re-export**，不搬家。最终它住在 `csv.ts` 里，因为「解析出什么形状」由解析器决定，落库只是它的消费者。

- Produces:
  - `ImportedWorkout`、`CsvParseResult`、`CsvSource`、`parseWorkoutCsv(text: string): CsvParseResult`

> **`CsvParseResult` 有四个字段，第四个是 `poundsConverted: number`**（有多少行的重量原本是磅、已被换算成公斤）。它必须由解析器算出来：换算之后公斤和磅在 `workouts` 里完全相同，事后无法反推。预览页要靠它写「已把 N 行磅换算成公斤」——135 磅当成 135 kg 会直接毁掉进步曲线，这件事必须让用户看见。**没有磅时是 `0`，不是 `undefined`。**

- [ ] **Step 1: 写失败的测试**

创建 `src/domain/csv.test.ts`：

```ts
import { parseWorkoutCsv } from './csv';

/** 把几行拼成一份 CSV 文本，行间统一用 \r\n（真实导出文件大多如此） */
function csv(rows: string[]): string {
  return rows.join('\r\n');
}

describe('CSV 解析：三种来源的列名', () => {
  it('Strong 的表头（Date / Workout Name / Exercise Name / Weight / Reps）', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Workout Name,Exercise Name,Set Order,Weight,Reps',
        '2024-01-15 09:30:00,推日,卧推,1,60,8',
        '2024-01-15 09:30:00,推日,卧推,2,60,7',
        '2024-01-15 09:30:00,推日,飞鸟,1,15,12',
      ]),
    );

    expect(result.skipped).toEqual([]);
    expect(result.detected.source).toBe('strong');
    expect(result.workouts).toHaveLength(1);
    const workout = result.workouts[0];
    expect(workout.name).toBe('推日');
    expect(workout.exercises.map((e) => e.name)).toEqual(['卧推', '飞鸟']);
    expect(workout.exercises[0].sets).toEqual([
      { weight: 60, reps: 8 },
      { weight: 60, reps: 7 },
    ]);
  });

  it('Hevy 的表头（title / start_time / exercise_title / weight_kg）', () => {
    const result = parseWorkoutCsv(
      csv([
        'title,start_time,exercise_title,set_index,weight_kg,reps',
        'Pull Day,2024-02-03 18:00:00,划船,0,70,8',
        'Pull Day,2024-02-03 18:00:00,划船,1,70,8',
      ]),
    );

    expect(result.detected.source).toBe('hevy');
    expect(result.workouts[0].name).toBe('Pull Day');
    expect(result.workouts[0].exercises[0].sets).toHaveLength(2);
  });

  it('训记的表头（日期 / 训练名称 / 动作名称 / 重量(kg) / 次数）', () => {
    const result = parseWorkoutCsv(
      csv([
        '日期,训练名称,动作名称,组序号,重量(kg),次数',
        '2024/3/5 19:00,腿日,深蹲,1,100,5',
      ]),
    );

    expect(result.detected.source).toBe('xunji');
    expect(result.workouts[0].exercises[0].name).toBe('深蹲');
    expect(result.workouts[0].exercises[0].sets).toEqual([{ weight: 100, reps: 5 }]);
  });
});

describe('CSV 解析：脏数据', () => {
  it('带 UTF-8 BOM 时首列名照样能匹配', () => {
    const result = parseWorkoutCsv(
      '\uFEFF' +
        csv([
          'Date,Exercise Name,Weight,Reps',
          '2024-01-15 09:30:00,卧推,60,8',
        ]),
    );
    // BOM 没被剥掉的话首列名是 '\uFEFFDate'，匹配不上 → 整个文件读不懂
    expect(result.workouts).toHaveLength(1);
  });

  it('字段里有逗号时靠引号保住', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,"卧推, 上斜",60,8',
      ]),
    );
    expect(result.workouts[0].exercises[0].name).toBe('卧推, 上斜');
  });

  it('字段里有转义的引号', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,"他说""上斜""卧推",60,8',
      ]),
    );
    expect(result.workouts[0].exercises[0].name).toBe('他说"上斜"卧推');
  });

  it('重量带单位 kg', () => {
    const result = parseWorkoutCsv(
      csv(['Date,Exercise Name,Weight,Reps', '2024-01-15 09:30:00,卧推,60kg,8']),
    );
    expect(result.workouts[0].exercises[0].sets[0].weight).toBe(60);
  });

  it('重量是磅时换算成公斤', () => {
    const result = parseWorkoutCsv(
      csv(['Date,Exercise Name,Weight,Reps', '2024-01-15 09:30:00,卧推,135 lb,8']),
    );
    // 135 lb = 61.23 kg，保留两位
    expect(result.workouts[0].exercises[0].sets[0].weight).toBeCloseTo(61.23, 2);
  });

  it('自重动作（BW / 空）记 0 kg，不算读不懂', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,引体向上,BW,8',
        '2024-01-15 09:30:00,俯卧撑,,20',
      ]),
    );
    expect(result.skipped).toEqual([]);
    expect(result.workouts[0].exercises[0].sets[0].weight).toBe(0);
    expect(result.workouts[0].exercises[1].sets[0].weight).toBe(0);
  });

  it('只有日期没有时间时按当天 12:00 本地时间', () => {
    const result = parseWorkoutCsv(
      csv(['Date,Exercise Name,Weight,Reps', '2024-01-15,卧推,60,8']),
    );
    const date = new Date(result.workouts[0].startedAt);
    expect(date.getFullYear()).toBe(2024);
    expect(date.getMonth()).toBe(0);
    expect(date.getDate()).toBe(15);
    // 零点最容易被时区处理推到前一天，所以刻意取正午
    expect(date.getHours()).toBe(12);
  });

  it('空行与重复表头行被跳过，且不计入 skipped', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '',
        '2024-01-15 09:30:00,卧推,60,8',
        'Date,Exercise Name,Weight,Reps',
        '   ',
      ]),
    );
    // 它们不是「读不懂」，报给用户只会让人以为文件有问题
    expect(result.skipped).toEqual([]);
    expect(result.workouts[0].exercises[0].sets).toHaveLength(1);
  });

  it('读不懂的行进 skipped，并带文件里的真实行号与原因', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,卧推,60,8',
        '15/1/24 上午9:30,深蹲,100,5',
      ]),
    );

    expect(result.workouts).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    // 第 1 行是表头，所以坏行是第 3 行 —— 用户要能对着表格直接找到它
    expect(result.skipped[0].line).toBe(3);
    expect(result.skipped[0].reason).toContain('日期');
  });

  it('次数不是数字时也进 skipped', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,卧推,60,八次',
      ]),
    );
    expect(result.workouts).toEqual([]);
    expect(result.skipped[0].line).toBe(2);
  });

  it('同一个动作在不同行出现时合并成一个动作、组按顺序累加', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,卧推,60,8',
        '2024-01-15 09:35:00,深蹲,100,5',
        '2024-01-15 09:40:00,卧推,65,6',
      ]),
    );

    const workout = result.workouts[0];
    // 三行属于同一场（同一天、时间挨着）—— 见下面那条测试的说明
    expect(workout.exercises.map((e) => e.name)).toEqual(['卧推', '深蹲']);
    expect(workout.exercises[0].sets).toEqual([
      { weight: 60, reps: 8 },
      { weight: 65, reps: 6 },
    ]);
  });

  it('不同日期的行拆成不同的训练', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,卧推,60,8',
        '2024-01-16 09:30:00,深蹲,100,5',
      ]),
    );

    expect(result.workouts).toHaveLength(2);
    // 越早的在前：历史列表与进步曲线都按时间排，导入的数组也按时间排
    expect(result.workouts[0].startedAt).toBeLessThan(result.workouts[1].startedAt);
    expect(result.workouts[0].exercises[0].name).toBe('卧推');
  });

  it('没有锻炼名那一列时，一场训练的名字是 null', () => {
    const result = parseWorkoutCsv(
      csv(['Date,Exercise Name,Weight,Reps', '2024-01-15 09:30:00,卧推,60,8']),
    );
    expect(result.workouts[0].name).toBeNull();
  });

  it('只有表头没有数据行时，workouts 是空的', () => {
    const result = parseWorkoutCsv('Date,Exercise Name,Weight,Reps');
    expect(result.workouts).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('完全认不出的文件（比如选错成别的 csv）返回空结果，不抛异常', () => {
    const result = parseWorkoutCsv(csv(['name,email', 'a,b']));
    expect(result.workouts).toEqual([]);
    // 这是「选错文件」的情形，界面据此不给「确认导入」按钮
    expect(result.detected.source).toBe('unknown');
  });

  it('finishedAt 默认比 startedAt 晚，且不早于它', () => {
    const result = parseWorkoutCsv(
      csv([
        'Date,Exercise Name,Weight,Reps',
        '2024-01-15 09:30:00,卧推,60,8',
        '2024-01-15 11:00:00,飞鸟,15,12',
      ]),
    );
    const workout = result.workouts[0];
    // 一场训练的时长取「最后一行的时间 − 第一行的时间」，不足 1 分钟时兜底 1 分钟
    expect(workout.finishedAt).toBeGreaterThan(workout.startedAt);
  });
});
```

- [ ] **Step 2: 跑测试，确认它是红的**

Run: `npx jest src/domain/csv.test.ts`
Expected: FAIL —— `Cannot find module './csv'`。

- [ ] **Step 3: 实现**

创建 `src/domain/csv.ts`。整体结构：**先切行 → 找表头 → 认来源 → 逐行取值 → 组装**。要实现的关键点：

1. **`ImportedWorkout` 定义在这里**（见 Interfaces 里的顺序说明）。

```ts
/** 与来源格式无关的中间结构。CSV 解析与手动补记录都产出它，落库只认它 */
export interface ImportedWorkout {
  startedAt: number;
  finishedAt: number;
  name: string | null;
  exercises: { name: string; sets: { weight: number; reps: number }[] }[];
}

export interface CsvParseResult {
  workouts: ImportedWorkout[];
  /** 读不懂的行：**文件里的真实行号**（从 1 开始，含表头）+ 原因 */
  skipped: { line: number; reason: string }[];
  /** 识别到的来源与用到的列名，预览页要写出来让用户确认 */
  detected: { source: 'strong' | 'hevy' | 'xunji' | 'unknown'; columns: Record<string, string> };
}

export function parseWorkoutCsv(text: string): CsvParseResult;
```

2. **分词器**（`splitCsvLine`）：按状态机走字符，支持双引号包裹、`""` 转义、引号内的逗号与换行。分隔符只支持逗号（三种来源都用逗号）。

3. **剥 BOM**：`text.replace(/^\uFEFF/, '')`。不剥的话首列名匹配不上，整个文件报废。

4. **来源识别**：把表头每个单元格规范化（`trim` + 去空格 + 小写 + 全角括号转半角），逐个来源比对必需列。三张映射表：

```ts
const SOURCES = [
  {
    source: 'strong',
    columns: { date: 'date', name: 'workout name', exercise: 'exercise name', weight: 'weight', reps: 'reps' },
  },
  {
    source: 'hevy',
    columns: { date: 'start_time', name: 'title', exercise: 'exercise_title', weight: 'weight_kg', reps: 'reps' },
  },
  {
    source: 'xunji',
    columns: { date: '日期', name: '训练名称', exercise: '动作名称', weight: '重量(kg)', reps: '次数' },
  },
] as const;
```

四列（日期/动作/重量/次数）全中才算这个来源；`name` 列可有可无。

5. **日期解析**（`parseDate`）：依次尝试
   - `2024-01-15 09:30:00` / `2024-01-15T09:30:00` / `2024-01-15 09:30`（正则取年月日时分秒，**手动构造 `new Date(y, m-1, d, hh, mm, ss)`**，不走 `Date.parse` —— 后者对无时区的字符串在不同引擎上行为不同）
   - `2024/1/15 9:30`
   - `1/15/2024 9:30 AM` / `01/15/2024 09:30`（**按美式月/日/年**：Strong 与 Hevy 都是美国 App；这一条要写进注释，因为「15/1/2024」会被它判为月=15 而失败进 skipped，这是刻意的）
   - 只有日期 → 当天 12:00 本地时间
   全部失败 → `null`，该行进 `skipped`。

6. **数值解析**（`parseWeight` / `parseReps`）：
   - `parseWeight`：空或 `BW`/`bw`/`自重` → `0`；带 `kg`/`公斤` → 去掉后缀；带 `lb`/`lbs`/`磅` → `× 0.45359237` 后保留两位（`Math.round(x * 100) / 100`）；纯数字 → 原值；其余 → `null`（进 skipped）
   - `parseReps`：必须是正整数，否则 `null`

7. **分组**：按 `startedAt` 的**日期字符串**（本地时区的 `YYYY-MM-DD`）分组，而不是按「时间差小于 N 小时」——后者会把跨零点的训练拆开或把两天并在一起。同一天内的行都算一场。
   - 组内 `startedAt` 取**最早那一行**的时间，`finishedAt` 取**最晚那一行**的时间；两者相同时（只有一行，或者所有行同一分钟）`finishedAt = startedAt + 60_000`（不这么做的话训练时长是 0，历史上显示「0 分钟」）。
   - 组内动作按**首次出现的顺序**排列，同名动作合并。
   - 最后把 `workouts` 按 `startedAt` 升序排。

- [ ] **Step 4: 跑测试，确认绿了**

Run: `npx jest --maxWorkers=1 src/domain/csv.test.ts`
Expected: PASS，19 条。

> 如果某条测试的实现里发现了更简单的做法（比如 `parseDate` 能用别的方式覆盖全部格式），**以测试为准改写实现，不要改测试的期望** —— 这些期望就是设计文档 §5.2 那张表。

- [ ] **Step 5: 提交**

```bash
git add src/domain/csv.ts src/domain/csv.test.ts
git commit -m "feat(domain): CSV 解析（Strong / Hevy / 训记三种列名 + 脏数据处理）"
```

---

## Task 15: 导入落库

**Files:**
- Create: `src/domain/importRecords.ts`
- Create: `src/repositories/importRepo.ts`
- Test: `src/domain/importRecords.test.ts`
- Test: `src/repositories/importRepo.test.ts`

**Interfaces:**
- Consumes: Task 14 的 `ImportedWorkout`（在 `csv.ts` 里定义，从 `importRecords.ts` **再导出**）
- Produces:
  - `validateImportedWorkouts(workouts: ImportedWorkout[]): { ok: true } | { ok: false; reason: string }`（`domain/importRecords.ts`）
  - `normalizeExerciseName(name: string): string`（`domain/importRecords.ts`）
  - `importWorkouts(exec, workouts): Promise<ImportResult>`，`ImportResult = { sessions: number; exercises: number; createdExercises: number }`（`importRepo.ts`）

> **`ImportedWorkout` 的归属，说清楚一次。** 它由 Task 14 定义在 `src/domain/csv.ts`（「解析出什么形状」由解析器决定），落库只是它的消费者。本 Task 的 `importRecords.ts` 把它 `export type { ImportedWorkout }` 再导出，作为**落库这一侧的规范入口**。
>
> 因此约定：**`importRecords.ts` 之外的任何文件都从 `importRecords` import 它，不从 `csv` import**。只有 `importRecords.ts` 自己从 `csv` import。`importRepo.ts`、`importRepo.test.ts`、界面（Task 16）一律如此 —— 同一个类型有两个 import 来源，是「该从哪拿」这种问题每次都要重新想一遍的开始。

- [ ] **Step 1: 写 `importRecords` 的失败测试**

创建 `src/domain/importRecords.test.ts`：

```ts
import { normalizeExerciseName, validateImportedWorkouts } from './importRecords';
// 走规范入口 importRecords（它再导出），不直接找 csv —— 见 Task 15 开头那条约定
import type { ImportedWorkout } from './importRecords';

function workout(overrides: Partial<ImportedWorkout> = {}): ImportedWorkout {
  return {
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_003_600_000,
    name: '推日',
    exercises: [{ name: '卧推', sets: [{ weight: 60, reps: 8 }] }],
    ...overrides,
  };
}

describe('normalizeExerciseName', () => {
  it('去首尾空格、折叠中间空白', () => {
    expect(normalizeExerciseName('  卧  推 ')).toBe('卧推');
  });

  it('全角转半角（括号、字母、数字）', () => {
    // 别的 App 导出的名字常常是全角，本机动作库是半角。
    // 不归一化的话「卧推（窄距）」和「卧推(窄距)」会变成两个动作，
    // 进步曲线被切成两段 —— 这是导入功能最容易踩、事后最难修的坑。
    expect(normalizeExerciseName('卧推（窄距）')).toBe('卧推(窄距)');
    expect(normalizeExerciseName('Ｂｅｎｃｈ')).toBe('Bench');
  });

  it('英文统一小写，大小写不同的同一个动作归一成一样', () => {
    expect(normalizeExerciseName('Bench Press')).toBe(
      normalizeExerciseName('bench press'),
    );
  });
});

describe('validateImportedWorkouts', () => {
  it('正常的一份通过', () => {
    expect(validateImportedWorkouts([workout()])).toEqual({ ok: true });
  });

  it('结束时间早于开始时间时被拒', () => {
    const result = validateImportedWorkouts([
      workout({ startedAt: 2000, finishedAt: 1000 }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('结束时间');
  });

  it('一个动作都没有的训练被拒', () => {
    const result = validateImportedWorkouts([workout({ exercises: [] })]);
    expect(result.ok).toBe(false);
  });

  it('有动作但一组都没有时也被拒', () => {
    // 空训练进了库就是一条点开什么都没有的历史记录，用户既看不懂也删不掉
    const result = validateImportedWorkouts([
      workout({ exercises: [{ name: '卧推', sets: [] }] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('一组');
  });

  it('空数组直接通过（没有东西要导）', () => {
    expect(validateImportedWorkouts([])).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: 跑测试，确认它是红的**

Run: `npx jest src/domain/importRecords.test.ts`
Expected: FAIL —— `Cannot find module './importRecords'`。

- [ ] **Step 3: 实现 `src/domain/importRecords.ts`**

```ts
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
```

- [ ] **Step 4: 跑测试，确认绿了**

Run: `npx jest src/domain/importRecords.test.ts`
Expected: PASS，8 条。

- [ ] **Step 5: 写 `importRepo` 的失败测试**

创建 `src/repositories/importRepo.test.ts`：

```ts
import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
// **从 importRecords import，不要从 csv import**：后者只是它的定义处，
// 前者是规范入口（见 importRecords.ts 里的再导出说明）。两处都写会让同一个
// 类型有两个来源，而「该从哪 import」这种问题每次都要重新想一遍。
import type { ImportedWorkout } from '../domain/importRecords';
import { listExercises } from './exerciseRepo';
import { importWorkouts } from './importRepo';
import { listCompletedSetPoints } from './progressRepo';
import { listSessionSummaries } from './sessionRepo';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

/** 造一场导入用的训练。组默认 60kg×8。 */
function workout(overrides: Partial<ImportedWorkout> = {}): ImportedWorkout {
  return {
    startedAt: T0,
    finishedAt: T0 + 3_600_000,
    name: '推日',
    exercises: [{ name: '卧推', sets: [{ weight: 60, reps: 8 }] }],
    ...overrides,
  };
}

describe('importWorkouts', () => {
  it('一场训练连同它的动作与组一起落库', async () => {
    const exec = await createMigratedExecutor();

    const result = await importWorkouts(exec, [workout()]);

    expect(result).toEqual({ sessions: 1, exercises: 1, createdExercises: 1 });
    const summaries = await listSessionSummaries(exec, 10);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].setCount).toBe(1);
    expect(summaries[0].volumeKg).toBe(480);
  });

  it('导进来的记录出现在进步曲线里（这是整个功能的重点）', async () => {
    const exec = await createMigratedExecutor();

    await importWorkouts(exec, [workout()]);

    const points = await listCompletedSetPoints(exec);
    // 进步曲线只认「已完成 + 属于一场已结束的训练」，导入的记录必须两条都满足
    expect(points).toHaveLength(1);
    expect(points[0].weight).toBe(60);
    expect(points[0].reps).toBe(8);
  });

  it('同名动作只新建一次（42 场里出现 300 次也只建一条）', async () => {
    const exec = await createMigratedExecutor();
    const many: ImportedWorkout[] = [];
    for (let day = 0; day < 5; day += 1) {
      many.push(
        workout({
          startedAt: T0 + day * DAY,
          finishedAt: T0 + day * DAY + 3_600_000,
          exercises: [
            { name: '卧推', sets: [{ weight: 60, reps: 8 }] },
            { name: '卧推', sets: [{ weight: 65, reps: 6 }] },
          ],
        }),
      );
    }

    const result = await importWorkouts(exec, many);

    // 动作库里只有一条「卧推」。建重了的话，进步曲线会被切成好几段。
    const exercises = await listExercises(exec);
    expect(exercises.filter((e) => e.name === '卧推')).toHaveLength(1);
    expect(result.createdExercises).toBe(1);
  });

  it('同一场里同名的动作合并成一个，组按顺序排', async () => {
    const exec = await createMigratedExecutor();

    await importWorkouts(exec, [
      workout({
        exercises: [
          { name: '卧推', sets: [{ weight: 60, reps: 8 }] },
          { name: '深蹲', sets: [{ weight: 100, reps: 5 }] },
          { name: '卧推', sets: [{ weight: 65, reps: 6 }] },
        ],
      }),
    ]);

    const points = await listCompletedSetPoints(exec);
    const bench = points.filter((p) => p.weight !== 100);
    expect(bench.map((p) => p.weight)).toEqual([60, 65]);
  });

  it('库里已有的同名动作被复用，不新建', async () => {
    const exec = await createMigratedExecutor();
    // 大小写与全角差异都要能匹配上
    await importWorkouts(exec, [
      workout({ exercises: [{ name: 'Bench Press', sets: [{ weight: 60, reps: 8 }] }] }),
    ]);

    const result = await importWorkouts(exec, [
      workout({
        startedAt: T0 + DAY,
        exercises: [{ name: 'Ｂｅｎｃｈ　Ｐｒｅｓｓ', sets: [{ weight: 62.5, reps: 8 }] }],
      }),
    ]);

    expect(result.createdExercises).toBe(0);
    expect((await listExercises(exec)).filter((e) => e.name === 'Bench Press')).toHaveLength(1);
    // 两场的点挂在同一个动作上，曲线是连着的
    const points = await listCompletedSetPoints(exec);
    expect(new Set(points.map((p) => p.exerciseId)).size).toBe(1);
  });

  it('导进来的每个动作都预建了一条待完成的组占位', async () => {
    const exec = await createMigratedExecutor();

    await importWorkouts(exec, [workout()]);

    // 和本机练出来的一场一样：用户要是想接着这场补记，界面得找得到「该记哪一组」。
    // 不过导入的场次已经 finished，记录页不会打开它 —— 这条是防将来有人
    // 把导入的场次做成「进行中」的。
    const unfinished = await exec.first<{ n: number }>(
      'SELECT COUNT(*) AS n FROM set_entry WHERE is_completed = 0',
    );
    expect(Number(unfinished?.n ?? 0)).toBe(1);
  });

  it('中途失败时整体回滚：库里一行都不多', async () => {
    const exec = await createMigratedExecutor();
    // 第二条的动作名不是字符串。校验层会拦下它，但我们要测的是**仓储自己**
    // 在写坏数据时的回滚，所以绕过校验直接喂进去。
    const broken = {
      startedAt: T0 + DAY,
      finishedAt: T0 + DAY + 3_600_000,
      name: null,
      exercises: [{ name: 123 as unknown as string, sets: [{ weight: 60, reps: 8 }] }],
    };

    await expect(
      importWorkouts(exec, [workout(), broken]),
    ).rejects.toThrow();

    // 第一条也不许留下来 —— 半个文件导进去比一条都没导更糟
    expect(await listSessionSummaries(exec, 10)).toEqual([]);
    expect(await listExercises(exec)).toEqual([]);
  });

  it('空数组时什么都不做，也不报错', async () => {
    const exec = await createMigratedExecutor();
    expect(await importWorkouts(exec, [])).toEqual({
      sessions: 0,
      exercises: 0,
      createdExercises: 0,
    });
  });
});
```

- [ ] **Step 6: 跑测试，确认它是红的**

Run: `npx jest src/repositories/importRepo.test.ts`
Expected: FAIL —— `Cannot find module './importRepo'`。

- [ ] **Step 7: 实现 `src/repositories/importRepo.ts`**

```ts
import type { SqlExecutor } from '../db/types';
// **规范化入口是 importRecords，不是 csv**：`ImportedWorkout` 的定义在 csv.ts，
// 但 importRecords 把它再导出成「落库这一侧的类型契约」。这里跟着契约走，
// 将来类型换了住处（比如真的搬进 importRecords）时不必回头改这里。
import type { ImportedWorkout } from '../domain/importRecords';
import { validateImportedWorkouts, normalizeExerciseName } from '../domain/importRecords';
import { newId } from '../lib/id';
import { createCustomExercise, listExercises } from './exerciseRepo';

/**
 * 把一批「与来源无关的训练」写进库。**CSV 导入与手动补记录共用这一个入口。**
 *
 * 两条路径的差别一旦出现（比如一边写了 `completed_at`、另一边忘了），进步曲线
 * 会莫名其妙地少点，而这种 bug 极难定位 —— 所以落库只有这一条路。
 *
 * 整批跑在一个事务里。几百场训练逐条 INSERT 在手机上会读秒，事务是唯一能让它
 * 可接受的做法，顺带买到「要么全成、要么全不动」：半个文件导进去、用户却以为
 * 导完了，比直接报错糟得多。
 */

export interface ImportResult {
  /** 新建了多少场训练 */
  sessions: number;
  /** 涉及多少个不同的动作（含复用的） */
  exercises: number;
  /** 其中有多少个是这次新建的自定义动作 —— 预览与结果提示都要说这个数 */
  createdExercises: number;
}

export async function importWorkouts(
  exec: SqlExecutor,
  workouts: ImportedWorkout[],
): Promise<ImportResult> {
  const check = validateImportedWorkouts(workouts);
  if (!check.ok) throw new Error(check.reason);
  if (workouts.length === 0) {
    return { sessions: 0, exercises: 0, createdExercises: 0 };
  }

  // 动作名的匹配表一次性读进内存。**这份缓存是硬需求**：42 场训练里「卧推」
  // 可能出现 300 次，每次都查一遍库是 300 次查询；而每次各建一个新动作
  // 会让进步曲线被切成三百段。两者都不能接受。
  const byNormalizedName = new Map<string, string>();
  for (const exercise of await listExercises(exec)) {
    // 库里已有的动作也按同样的规则归一化，否则「Bench Press」与
    // 「bench press」会被当成两个
    const key = normalizeExerciseName(exercise.name);
    if (!byNormalizedName.has(key)) byNormalizedName.set(key, exercise.id);
  }

  const usedExerciseIds = new Set<string>();
  let createdExercises = 0;
  let sessionCount = 0;

  await exec.run('BEGIN');
  try {
    for (const workout of workouts) {
      const sessionId = newId();
      // `template_id` 一律为 null：导入的记录不属于任何计划，也就不会
      // 参与轮转（轮转只认 template_id 非空的场次）
      await exec.run(
        `INSERT INTO session (id, name, started_at, finished_at, note, template_id)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
        [sessionId, workout.name, workout.startedAt, workout.finishedAt],
      );
      sessionCount += 1;

      // 同一场里同名的动作合并到一个 session_exercise 上
      const merged = new Map<string, { name: string; sets: typeof workout.exercises[number]['sets'] }>();
      for (const item of workout.exercises) {
        const key = normalizeExerciseName(item.name);
        const existing = merged.get(key);
        if (existing) {
          existing.sets.push(...item.sets);
        } else {
          merged.set(key, { name: item.name, sets: [...item.sets] });
        }
      }

      let sessionExercisePosition = 0;
      for (const [key, item] of merged) {
        let exerciseId = byNormalizedName.get(key);
        if (!exerciseId) {
          const created = await createCustomExercise(exec, item.name, null, null);
          exerciseId = created.id;
          byNormalizedName.set(key, exerciseId);
          createdExercises += 1;
        }
        usedExerciseIds.add(exerciseId);

        const sessionExerciseId = newId();
        await exec.run(
          `INSERT INTO session_exercise (id, session_id, exercise_id, position, note)
           VALUES (?, ?, ?, ?, NULL)`,
          [sessionExerciseId, sessionId, exerciseId, sessionExercisePosition],
        );
        sessionExercisePosition += 1;

        for (const [index, set] of item.sets.entries()) {
          await exec.run(
            `INSERT INTO set_entry
               (id, session_exercise_id, position, weight, reps, is_completed, rest_seconds, rest_started_at, completed_at)
             VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?)`,
            [
              newId(),
              sessionExerciseId,
              index,
              set.weight,
              set.reps,
              // 没有真实的完成时刻数据，用这一场的结束时间。它只影响
              // 「最近碰过哪一组」这类推导，而导入的场次已经结束、不会被 resume
              workout.finishedAt,
            ],
          );
        }
      }
    }
    await exec.run('COMMIT');
  } catch (error) {
    // 回滚自身也可能抛（连接已断之类）。调用方更需要知道「导入为什么失败」，
    // 所以回滚的异常吞掉，抛出去的必须是原始异常 —— 不换成自己的错误。
    try {
      await exec.run('ROLLBACK');
    } catch {
      // 忽略：下面抛原始异常
    }
    throw error;
  }

  return {
    sessions: sessionCount,
    exercises: usedExerciseIds.size,
    createdExercises,
  };
}
```

- [ ] **Step 8: 跑测试，确认绿了**

Run: `npx jest src/repositories/importRepo.test.ts; npx tsc --noEmit`
Expected: PASS，8 条；tsc 干净。

- [ ] **Step 9: 提交**

```bash
git add src/domain/importRecords.ts src/domain/importRecords.test.ts src/repositories/importRepo.ts src/repositories/importRepo.test.ts
git commit -m "feat(import): 导入落库（动作名只建一次、整批一个事务）"
```

---

## Task 16: 导入界面与手动补记录

**Files:**
- Create: `app/import/index.tsx`
- Modify: `app/_layout.tsx`（注册路由）
- Modify: `app/(tabs)/settings.tsx`（加「记录管理」卡片）
- Modify: `src/lib/backupFile.ts`（加一个「选文件并读文本」的函数，或复用现有的选文件逻辑）

**Interfaces:**
- Consumes: Task 14 `parseWorkoutCsv` / `ImportedWorkout`、Task 15 `importWorkouts`、Task 13 `ExercisePickerModal`、`Stepper`（`src/components/Stepper.tsx`）
- Produces: 无（终端界面）

- [ ] **Step 1: 看现有的选文件实现**

先读 `src/lib/backupFile.ts`，看 `pickAndImportBackup` 是怎么调 `expo-document-picker` + `expo-file-system` 读文件内容的。**照它的写法**加一个：

```ts
/**
 * 选一个文件并把它的内容当文本读出来。用于 CSV 导入。
 *
 * 与备份导入分开：备份那条路要 `JSON.parse` + `validateBackup`，这条要交给
 * CSV 解析器。共用的只有「选文件 + 读文本」这两步，所以抽的是这两步。
 *
 * @returns 文件文本；**用户取消时返回 null**（不是错误，不弹任何东西）
 * @throws 选文件或读文件失败时抛出原始异常（由界面弹给用户）
 */
export async function pickTextFile(): Promise<string | null>;
```

照着 `pickAndImportBackup` 里现有的 `DocumentPicker` 选项写（`type: ['text/csv', 'text/comma-separated-values', 'text/plain', '*/*']` —— **`*/*` 要留着**：Android 上不同文件管理器给 CSV 报的 MIME 五花八门，只写 `text/csv` 会让用户根本选不中自己的文件）。

- [ ] **Step 2: 写导入页**

创建 `app/import/index.tsx`。两个模式共用一个路由（`useLocalSearchParams` 读 `mode`：`'csv'` 或 `'manual'`，默认 `'csv'`）。

**CSV 模式的三个状态**：

```
['idle']  选文件按钮 + 一句说明（支持 Strong / Hevy / 训记 导出的 CSV）
   ↓ 选到文件
['preview'] 预览（下面是文案骨架）
   ↓ 确认导入
['done'] 成功提示（Alert 之后 router.back()）
```

预览屏文案（数字全部来自 `parseWorkoutCsv` 的结果与实际比对）：

```
准备导入 42 场训练

时间范围    2023年4月8日 ~ 2024年1月12日
涉及动作    18 个，其中 3 个本机没有
            （将新建为自定义动作）
读不懂      7 行会被跳过                 [展开]

[ 确认导入 ]    [ 取消 ]
```

要点：
- **`workouts.length === 0` 时不给「确认导入」按钮**，只显示「这个文件里没有能识别的训练记录」+ 一句「请确认选的是从其他 App 导出的训练记录 CSV」+「重新选择」/「取消」。这正是「用户选错文件」的兜底。
- 「将新建为自定义动作」的名单要列出来：拿 `workouts` 里所有动作名去 `listExercises` 的结果里做**同样的归一化匹配**（复用 Task 15 的 `normalizeExerciseName`，不要自己再写一遍比较逻辑），差集就是新动作的名字。去重后按名字排序显示，超过 5 个就显示前 5 个 + 「等 N 个」。
- 「读不懂」那一行做成可展开（`useState` 控制），展开后逐行列出「第 37 行：日期的格式认不出来」。**`skipped` 为空时这一行整个不渲染**（写「0 行会被跳过」是噪音）。
- **「单位换算」那一行用 `poundsConverted`**（Task 14 已经实现）：`poundsConverted > 0` 时渲染 `已把 N 行磅换算成公斤`，等于 0 时**整行不渲染**。不要自己扫 CSV 文本去数 `lb` —— 那会把进 skipped 的行也算进去，而且判据和解析器不一致（解析器认 `lbs`/`pound`/`磅` 等多种写法）。
- 「确认导入」的按钮用 `loading` + `disabled`（`importWorkouts` 要写几百行，重复点击会跑第二遍）。成功后的 Alert 写清三个数：`导入 42 场训练、18 个动作（其中 3 个是新建的）`，然后 `router.back()`。
- 失败时把 `importWorkouts` 抛出的原始信息原样弹出来，并**留在预览屏**（用户还可以重选文件）——事务已回滚，库里没变。

**手动模式的表单**：

```
日期      [2024-01-15]      ← 用三个 Stepper（年/月/日）或一个 TextInput，
                              见下面的说明
时间      [09:30]
训练名    [未命名训练]
时长      [45] 分钟

动作
  1  卧推        60 kg × 8    [－] [＋] 组数: 3    [✕]
  2  飞鸟        15 kg × 12   [－] [＋] 组数: 3    [✕]
  [ ＋ 添加动作 ]

[ 保存 ]
```

要点：
- **日期时间用五个 `Stepper`**（年 / 月 / 日 / 时 / 分），与 App 里其他地方调数字的手感一致（记录页的重量、次数就是它）。不要用 `TextInput`：在手机上敲 `2024-01-15` 是件苦差事，而键盘类型、格式校验、非法日期三件事都要自己处理。
- ⚠️ **`Stepper` 只有 `min`，没有 `max`**（见 `src/components/Stepper.tsx` 的 props：`label / value / step / min / onChange`），而它的注释里明确写了「只有下限、没有上限……到顶了也让用户继续加」。所以：
  - **年份必须自己夹**：`onChange={(y) => setYear(Math.min(y, new Date().getFullYear()))}`，下限 1970。不夹的话用户能一路按到 3000 年，而那条记录会永远排在他历史列表的最上面。
  - 月 / 日 / 时 / 分同理要夹（1~12、1~31、0~23、0~55）。
  - **不要为此去改 `Stepper`**：它的「不设上限」是有意的（不同器械的最大配重差很远，卡死上限会挡住少数大重量器械）。夹取是**这一处业务**的规则，写在表单里。
- 月份变化时把「日」夹进当月天数（`new Date(y, m, 0).getDate()`），否则用户能造出 2 月 30 日 —— 而 `importWorkouts` 会把它交给 SQLite 存下来，历史里就出现一条不存在的日期。
- 训练名是唯一的 `TextInput`，空着就存 `null`。
- 「＋ 添加动作」用 Task 13 抽出来的 `ExercisePickerModal`。选中后往本地数组里加一项 `{ exerciseId, name, weight: 20, reps: 8, setCount: 3 }`。
- 每个动作一行：重量与次数各一个 `Stepper`（重量步长 2.5、次数步长 1，与记录页一致），组数一个 `Stepper`（步长 1，最小 1；上限自己夹到 20 —— 同上，`Stepper` 没有 `max`）。
- 「保存」把这些组装成 `ImportedWorkout`：`startedAt` = 选定的日期时间，`finishedAt` = `startedAt + 时长 × 60000`，`exercises` = 每项展开成 `sets: Array.from({ length: setCount }, () => ({ weight, reps }))`。然后走**同一个** `importWorkouts`。
- 一个动作都没加就点保存 → `Alert` 说「至少加一个动作」，不写库（`validateImportedWorkouts` 也会拦，但界面上先说一句更友好）。
- 保存成功后 `router.back()`。

- [ ] **Step 3: 注册路由 + 设置页入口**

`app/_layout.tsx` 加：

```tsx
          {/* 导入与手动补记录：顶部内容由页面自绘（分段切换两个模式），
              但用原生导航栏拿返回手势 */}
          <Stack.Screen name="import/index" options={{ title: '添加记录' }} />
```

`app/(tabs)/settings.tsx` 在「备份」卡片**之后**加：

```tsx
        <Card style={{ gap: space.sm }}>
          <Text variant="title">记录管理</Text>
          <Text variant="caption" color="textMuted">
            把你在别的 App 里记过的训练导进来，进步曲线就能接上之前的过程。
          </Text>

          <Button
            label="从其他 App 导入（CSV）"
            variant="secondary"
            onPress={() => router.push({ pathname: '/import', params: { mode: 'csv' } })}
            style={{ marginTop: space.sm }}
          />
          <Button
            label="手动添加一条记录"
            variant="secondary"
            onPress={() => router.push({ pathname: '/import', params: { mode: 'manual' } })}
          />
        </Card>
```

- [ ] **Step 4: 真机验收**

Run: `npx tsc --noEmit` 然后上设备：

1. 准备一份真的 Strong 导出 CSV（或按上面表头手写一份 10 行的）
2. 设置 → 从其他 App 导入 → 选文件 → 预览里的场数/动作数/新动作名单与文件对上
3. 故意把两行的日期改坏 → 重新导入 → 「N 行会被跳过」的 N 对，展开能看到具体行号与原因
4. 确认导入 → 成功提示的三个数与预览一致 → 历史里看到这些训练
5. 去进步页 → 曲线接着旧数据画下去（**这是整个功能的目的**）
6. 再导一次同一份文件 → **不报错**，但会多出一份重复记录（不做去重是刻意的：判断「这两场是不是同一场」没有可靠依据，而误合并会删掉用户的数据。预览里已经写清了将导入多少场）
7. 手动添加：加两个动作、改重量与组数、保存 → 历史里出现，进步曲线上有对应的点
8. 手动模式：一个动作都不加就点保存 → 弹「至少加一个动作」，不写库
9. 手动模式：选一个库里已有的动作（比如「深蹲」）→ 保存后进步曲线接在**原来那条**深蹲曲线上，不是新建一条

- [ ] **Step 5: 提交**

```bash
git add app/import app/_layout.tsx "app/(tabs)/settings.tsx" src/lib/backupFile.ts
git commit -m "feat(import): 导入预览页与手动补记录表单"
```

---

## Task 17: 网页预览的处理与文档收尾

**Files:**
- Modify: `src/db/demoExecutor.ts`（文件头说明）
- Modify: `app/(tabs)/settings.tsx`、`app/(tabs)/history.tsx`、`app/history/[id].tsx`、`app/(tabs)/index.tsx`（web 上隐藏入口）
- Modify: `docs/superpowers/specs/2026-10-07-plans-and-record-management-design.md`（§9 的落实记录）

**Interfaces:**
- Produces: 无

- [ ] **Step 1: 把 web 上点不动的入口藏起来**

`demoExecutor` 是按 SQL 形态分发的内存假库（不是 SQL 引擎），它现有的「`DELETE FROM <表>` 就清空整表」分支会直接吃掉 `deleteSession` 的语句，新表也会被静默丢弃。**在网页预览里这三处点下去没反应**，而一个点不动的按钮比没有按钮糟。

在四个界面里加同一个判断（`import { Platform } from 'react-native';`）：

- `app/(tabs)/history.tsx`：`Platform.OS === 'web'` 时不渲染每行的「删除」按钮
- `app/history/[id].tsx`：同上，不渲染底部的删除按钮
- `app/(tabs)/settings.tsx`：「训练计划」与「记录管理」两张卡片整个不渲染；取而代之在「备份」卡片里加一句 —— 只在 web 上显示：`网页预览用的是内置演示数据，计划管理与导入不可用；请在手机上使用这些功能。`
- `app/(tabs)/index.tsx`：计划卡片不渲染（`plannedId` 在 web 上永远是 null，因为它读的 `listTemplates` 会返回空数组 —— 这条其实是自洽的，**确认一下即可，不必额外加判断**）

**不要**把这些判断写成散在各处的 `Platform.OS === 'web'`——抽一个小工具（`src/lib/preview.ts` 里 `export const isWebPreview = Platform.OS === 'web';`），四个界面 import 同一个常量。理由：将来要给桌面端或别的预览留口子时只改一处。

- [ ] **Step 2: 在 `demoExecutor.ts` 的文件头说明里补一句**

在那段「它刻意不是什么」的注释末尾加：

```
 * - 分化计划（`split_template` / `template_exercise`）这两张表预览里**完全没有**：
 *   它们的语句会落进下面的「未知的表」警告。
 * - `DELETE FROM session WHERE id = ?` 会先命中「清空整表」那条分支。
 * 所以删记录、计划管理、导入这三处入口在网页预览里是**隐藏**的
 * （见 `src/lib/preview.ts`），而不是让用户点一个没反应的按钮。
```

- [ ] **Step 3: 跑全量并确认 web 打包不炸**

Run: `npx jest; npx tsc --noEmit`
Expected: 全绿、干净。

如果你有 `expo start --web` 的环境，起一次确认页面能加载、四个标签都能切（这一步只是防「新加的文件在 web 打包路径上不兼容」，比如误 import 了 `expo-sqlite`）。

- [ ] **Step 4: 更新 README（它已经有两处是错的了）**

`README.md` 里有两处会被这次改动变成**错的描述**，必须在收尾时改掉——文档与实现不一致是那种「下一个人照着文档写出 bug」的起点：

1. 第 7 行「**开始训练**：一键开始新训练，自动沿用上一次的动作组合。」→ 改成分化循环的说法：
   `- **训练计划**：自定义几套分化（推日 / 拉日 / 腿日……），开始训练时按顺序自动轮转；没建计划时沿用上一次的动作组合。`
2. 「功能」列表补三条：训练中可删动作、历史里可删记录、从其他 App 导入记录 + 手动补记录。
3. 「数据模型」那一节只有四张表，补上 `split_template`（分化计划）与 `template_exercise`（计划里的动作），并说明 `session.template_id` 的用途。
4. 「设计原则」补两条这次新立的：
   - **轮转指针不单独存**：从 `session.template_id` 推导，避免四处同步。
   - **导入只有一条落库路径**：CSV 与手填产出同一种中间结构，共用 `importRepo`。

- [ ] **Step 5: 在 spec 里记下落实结果**

在 `docs/superpowers/specs/2026-10-07-plans-and-record-management-design.md` 的 §9 末尾追加一段「落实记录」，用一句话说清实际做法与哪些验收项在真机上过了、哪些没过。**没做的验收项要写清「没做」**，不要写成「已通过」。

- [ ] **Step 6: 提交**

```bash
git add src/db/demoExecutor.ts src/lib/preview.ts "app/(tabs)/settings.tsx" "app/(tabs)/history.tsx" "app/history/[id].tsx" "app/(tabs)/index.tsx" docs/superpowers/specs/2026-10-07-plans-and-record-management-design.md README.md
git commit -m "chore(preview): 网页预览里隐藏不可用的入口，更新 README 与落实记录"
```

---

## 收尾检查（所有 Task 完成后）

- [ ] `npx jest` 全绿，且新增测试文件数 = 5（`rotation` / `csv` / `importRecords` / `templateRepo` / `importRepo`）
- [ ] `npx tsc --noEmit` 干净
- [ ] spec 的 §7.4 真机验收表 12 项逐条走过，**未过的项在 spec 的落实记录里写明**
- [ ] 真机重装一遍（`npx expo run:android`），因为这次的改动含迁移 v3 —— 老库升级这条路必须在真机上走一次（单测里是用手工造的 v2 库覆盖的，但真机的 `expo-sqlite` 是另一套实现）
- [ ] 用一份**旧版本导出**的备份文件导入一次，确认训练记录完整、计划为空
