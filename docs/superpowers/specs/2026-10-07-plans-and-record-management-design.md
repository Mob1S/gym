# 训练计划（分化循环）与记录管理 —— 设计文档

- **日期**：2026-10-07
- **状态**：已与用户确认，待实施
- **项目目录**：`C:\ccproject\gym`
- **一句话**：把「新训练复制上一场」换成**用户自定义的分化循环计划**，并补上训练中删动作、历史里删记录、从别处导记录这三件缺失的能力。

---

## 1. 问题

### 1.1 用户的四条原话

1. 训练不能默认以上次训练的动作开始，**这和每个健身分化循环里的逻辑不符合**；
2. 训练中**无法删动作**，这导致堆在上面的动作只会越来越多；
3. **无法增删训练记录**，测试过程中产生的废弃记录无法删除；
4. 用户在这个 App 之前**自己在其他地方记录的训练无法导入**，看不到之前的进步过程。

### 1.2 现状与根因

| # | 现象 | 代码位置 | 根因 |
|---|---|---|---|
| 1 | 每场新训练都长成上一场的样子 | `src/store/activeSession.ts:282-289` | `startNew` 固定读 `listSessions(exec, 1)`（最近一场**已结束**训练），把它整张动作清单复制过来。这是为「别让用户第一屏面对空列表」偷的懒，但它等于假设每个人每次都练同一套动作 |
| 2 | 动作只能加不能删 | `src/store/activeSession.ts:302-313`、`app/session/[id].tsx:569` | store 只有 `addExercise`；记录页顶部动作条只有一个「＋」。加错了、临时改计划都只能忍着，动作越堆越多 |
| 3 | 记录只进不出 | `src/repositories/sessionRepo.ts`（无 `deleteSession`）、`app/(tabs)/history.tsx`（无任何行操作） | 训练的唯一出口是「结束训练」写 `finished_at`。测出来的废弃记录、点错开的一场，都没有办法清掉 |
| 4 | 旧记录进不来 | `src/repositories/backupRepo.ts:95` | 现有的「导入」是 `importAll`，语义是**整库替换**，而且只认本 App 自己导出的 JSON。它解决的是「换手机」，不是「把别处的历史并进来」 |

### 1.3 已经存在的、本设计必须复用的东西

- **级联删除已经就绪**：`src/db/schema.ts:42,50` 两个外键都写了 `ON DELETE CASCADE`，`database.tsx:71` 每次打开连接都开 `PRAGMA foreign_keys = ON`。所以删一场训练只需要删 `session` 一行。
- **备份的「删除顺序」已经排好**：`backupRepo.importAll` 里 `set_entry → session_exercise → session → exercise` 的删除顺序可以直接照抄成单场删除的顺序。
- **事务的写法有现成范例**：`importAll` 的 `BEGIN / try / COMMIT / catch / ROLLBACK` 结构，以及「回滚自身的异常吞掉、抛原始异常」那条约定。
- **动作选择弹层只有一份实现**：`app/session/[id].tsx:56-68, 294-366`。手动补记录也要选动作，必须复用它（抽成组件），不能再写第二份。

---

## 2. 语义与不变量

### 2.1 术语

- **计划**（也叫分化、模板）：一组有序的动作，有名字。推日 / 拉日 / 腿日，或 A / B，或上肢 / 下肢，名字与套数全由用户定。
- **轮转**：练完一套，下一场自动轮到下一套。
- **当前计划**：按轮转规则算出来的、这一场该练的那一套。

### 2.2 计划里存什么、不存什么

**只存动作清单与顺序。不存目标组数、目标重量、目标次数。**

理由：目标是计划的一部分时，用户每改一次计划都要维护几十个数字；而「上次练了多少」本机已经自动沿用了（`getLastPerformance`），计划再写一份就是第二处真相，两处必然打架。用户对这一条的表述是「只存动作清单和顺序」。

### 2.3 轮转规则

```
今天该练哪一套 =
  取「最近一场已结束、且 template_id 非空」的训练所用模板
  → 在计划列表里找到它的位置 → 下一套（循环回到第一套）
  没有计划           → 沿用旧逻辑（复制最近一场已结束训练的动作）
  有计划但一场都没练过 → 第一套
  上一场用的模板已被删除 → 第一套
```

**轮转指针不单独存。** 它是从 `session.template_id` 推出来的：查一句「最近的 template_id 是哪个」即可。多存一个「下一个该练第几套」的字段，就要在用户跳过、删除计划、导入记录、导入备份这四条路径上同步维护它，而它一旦与事实不符，表现是「莫名跳了一套」——用户看得见，但很难解释。

### 2.4 三条不变量

1. **同一时刻只可能有一场进行中的训练。** 这条由 `startNew` 的 `'conflict'` 分支把守（见 `2026-09-21-workout-lifecycle-design.md`），本设计**不得**削弱它：新的 `startNew` 仍然先 `resume` 探一次。
2. **计划里的动作必须存在于动作库。** `template_exercise.exercise_id` 引用 `exercise(id)`；动作库里的动作不会被删（只有 `is_archived`），所以计划不会因为动作归档而失效。
3. **导入的记录不特殊。** 导进来的、手填的、本机练的记录在库里完全同构：都是一场 `finished_at` 非空的 `session`，加一串 `is_completed = 1` 的 `set_entry`。因此历史列表、进步曲线、「上次练了多少」三处都**不需要为导入写任何特判**。

---

## 3. 数据模型

### 3.1 新增两张表（迁移 v3）

```sql
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

ALTER TABLE session ADD COLUMN template_id TEXT;  -- 刻意不写 REFERENCES，见下面第三条
```

三点说明：

- **`template_exercise.exercise_id` 的外键与 `session_exercise` 的同名外键同向**，所以第 4 节删除顺序里它排在 `exercise` 之前即可，不需要新的顺序推理。
- **`session.template_id` 刻意不加外键约束。** `ALTER TABLE ... ADD COLUMN` 加的外键在 SQLite 里不会被后续写入强制（列级外键只在建表时生效），与其写一个不生效的约束误导后来的人，不如写清约定：**删除计划时由 `templateRepo.deleteTemplate` 负责把引用它的 `session.template_id` 置空**（一句 `UPDATE session SET template_id = NULL WHERE template_id = ?`）。这个子句能执行，因为 `deleteTemplate` 里没有 `session` 的 DELETE，不受 §4.2 那个坑影响。
- 表名用 `split_template` 而不是 `template`：SQLite 里 `template` 是普通标识符没有冲突，但 `TEMPLATE` 在别的 SQL 方言里是关键字，这个 App 将来若换库不至于撞名。

### 3.2 迁移与版本号

`src/db/migrations.ts` 追加 v3 一项；`src/db/types.ts` 的 `SCHEMA_VERSION` 从 2 改成 3（它只是写进备份文件的元信息，不参与任何判断）。

迁移项**不能并进 v1 或 v2**：那两项早就发布过，已经升到 v2 的库不会再跑它们（`migrate()` 只跑 `version > current` 的项）。

---

## 4. 仓储层

### 4.1 新增 `src/repositories/templateRepo.ts`

| 函数 | 说明 |
|---|---|
| `listTemplates(exec)` | 全部计划，按 `position` 升序；附带每个计划的动作数（聚合一次查完，不做 N+1） |
| `getTemplate(exec, id)` | 单个计划 + 它的动作清单（已 JOIN `exercise` 带上动作名） |
| `createTemplate(exec, name)` | `position` 取 `MAX(position)+1`；新计划是空的，由编辑界面引导加动作 |
| `renameTemplate(exec, id, name)` | 只改名字 |
| `deleteTemplate(exec, id)` | 先把引用它的 `session.template_id` 置空，再 `DELETE FROM split_template`（`template_exercise` 靠级联），最后**重排剩余计划的 `position`** |
| `setTemplateExercises(exec, id, exerciseIds)` | 整个替换这个计划的动作清单与顺序。编辑界面就是「本地改一份数组 → 保存时整体覆盖」，比逐个 diff（加哪个、删哪个、谁排第几）简单一个量级，而且不会出现半应用状态 |
| `moveTemplate(exec, id, direction)` | 上移 / 下移一位，与相邻计划交换 `position` |

### 4.2 `sessionRepo` 的改动

**新增 `deleteSession(exec, id)`。** 只写一句 `DELETE FROM session WHERE id = ?`，两个子表靠 `ON DELETE CASCADE`。

> ⚠️ **绝不要写 `DELETE FROM session WHERE id <> ?` 这类否定式 `NOT IN` 子查询。**
> `PRAGMA foreign_keys = ON` 下，SQLite 对 `session` 的删除会级联扫 `session_exercise`，
> 而这条 DELETE 正在读 `session_exercise` → 报 `database table is locked`。
> 单个 id 的删除不经过子查询，是安全的。

**新增 `deleteSessionExercise(exec, sessionExerciseId)`：**

```sql
DELETE FROM set_entry          WHERE session_exercise_id = ?;
DELETE FROM session_exercise   WHERE id = ?;
UPDATE session_exercise SET position = position - 1
 WHERE session_id = ? AND position > ?;
```

三句必须按这个顺序，且都由调用方传 `sessionId` 与「被删掉的那个 position」。重排是为了不留空洞——留着空洞 `ORDER BY position` 也还能用，但以后要把动作插到中间（拖拽排序）就会错位，是个埋着的坑。

**新增 `deleteIncompleteSetsOf(exec, sessionExerciseId)`**：只删 `is_completed = 0` 的那些占位组，用于「先留着」那条分支。

> **实施时的修正**：这一条最初写的是 `deleteCompletedSetsOf`（删光**所有**组、动作留在库里），靠「这个动作 sets 为空」把界面摘掉。但那样会让「先留着」把用户练过的组也删掉——而用户选它的意思恰恰是「**别删我的记录**，只是这一场别再让我看见它」。改成「删占位组、留已完成的组」之后，判据也必须跟着从「sets 为空」改成「**还有没有未完成的组**」（见 §6.2）。
>
> 这一句与 `deleteSessionExercise` 的第二句不冲突：`ON DELETE CASCADE` 不会因为「先删了组」而出错。

**`session` 的列清单加 `template_id`：**

- `SESSION_COLUMNS` 加 `template_id`，`SessionRow` 加 `template_id: string | null`，`toSession` 映射到 `WorkoutSession.templateId`。
- `createSession(exec, name, templateId)` 多收一个参数并写进库。**`startNew` 里的调用顺序必须是「先探冲突 → 再定计划 → 才建 session」**：轮转的输入是「最近一场已结束训练用的模板」，如果先把这一场建出来，虽然它 `finished_at` 还是 NULL、不会污染那个查询，但顺序一旦写成「先建后定」就很容易在后续改动里误用 `listSessions` 之类的接口把这一场算进去。定完计划再一次建，是唯一不需要推理的顺序。
- **`listSessions` / `listSessionSummaries` 的 WHERE 一律不加 `template_id` 条件**，它们的行为不变。
- **新增 `findLatestTemplateId(exec)`**：轮转的输入。

```sql
SELECT template_id FROM session
 WHERE finished_at IS NOT NULL AND template_id IS NOT NULL
 ORDER BY started_at DESC, rowid DESC
 LIMIT 1
```

`rowid DESC` 不能省：`started_at` 只有毫秒精度，同一毫秒的两场会完全并列，此时 SQLite 按扫描顺序返回（先插入的在前），语义就反了。这个坑 `setRepo.getLastPerformance` 的注释里已经写过两次。

### 4.3 新增 `src/repositories/importRepo.ts`

`importWorkouts(exec, workouts: ImportedWorkout[]): Promise<ImportResult>`

- **整批一个事务**：`BEGIN` → 逐个写 → `COMMIT`；`catch` 里 `ROLLBACK` 并抛**原始异常**（照抄 `importAll` 的写法）。几百场训练逐条 INSERT 在手机上会读秒，事务是唯一能让它可接受的做法，顺带买到「要么全成、要么全不动」。
- **动作名匹配是唯一入口**：`resolveExerciseId(exec, name, cache)` —— 先规范化（`trim`、全角转半角、连续空白折叠、大小写折叠），在**本次导入开始时一次性读进内存的 `exercise` 表**里查；查不到才 `createCustomExercise`，并立刻塞进缓存。
  > 这份缓存是必需的：42 场训练里「卧推」可能出现 300 次，每次都查一遍库是 300 次查询；而**每次各建一个新动作**则会让进步曲线被切成三百段——这是导入功能最容易踩、事后最难修的坑。
- 同一场训练里同名动作**合并**成一个 `session_exercise`（各家导出里同一个动作会重复出现，每次带不同组）。
- 写进去的每一组：`is_completed = 1`、`completed_at = finishedAt`、`rest_seconds = NULL`、`rest_started_at = NULL`。没有真实的组间休息数据，**编一个平均值比留空更糟**——`restAdvice` 要算平均休息时长，假数据会把它带偏。
- 返回 `{ sessions: number; exercises: number; createdExercises: number }`，供成功提示使用。

### 4.4 新增 `src/repositories/planRepo.ts`（轮转的取数）

只有一句查询（`findLatestTemplateId`）+ 一次 `listTemplates`，然后交给纯函数决定用哪套。把它单独放一个文件而不是塞进 `templateRepo`：`templateRepo` 是「计划的增删改查」，这里是「今天练哪套」的决策取数，两者被不同的界面消费。

> 也可以不新建文件，把 `findLatestTemplateId` 放 `sessionRepo`、决策纯函数放 `domain/rotation.ts`，由 `activeSession.startNew` 直接串起来。实施时按哪个文件更小来定，**但决策逻辑必须在 domain 里，不能写进 store**——写进 store 就没法单元测试「只有一套计划时永远轮到它」这类边界。

---

## 5. 领域层（纯函数，全部可单测）

### 5.1 `src/domain/rotation.ts`

```ts
/** 输入：全部计划（有序）、上一场用的计划 id（可能为 null） */
/** 输出：这一场该用的计划；没有计划时返回 null */
export function nextTemplateId(
  templates: { id: string }[],
  lastTemplateId: string | null,
): string | null;
```

四条边界必须各有一条测试：
- 三套计划、上一场是第二套 → 第三套
- 三套计划、上一场是第三套 → **回到第一套**（循环）
- 只有一套计划 → 永远是它（`index + 1` 取模不能出现越界）
- 上一场为 `null`、或它的 id 不在列表里（计划已被删） → 第一套

### 5.2 `src/domain/csv.ts`

```ts
export interface CsvParseResult {
  workouts: ImportedWorkout[];
  /** 读不懂的行，行号 + 原因，用于预览里的「7 行会被跳过」 */
  skipped: { line: number; reason: string }[];
  /** 识别到的来源与列映射，预览里写出来让用户确认 */
  detected: { source: string; columns: Record<string, string> };
  /**
   * 有多少行的重量原本是磅、已被换算成公斤，用于预览里的「12 行已换算」。
   * **必须由解析器算出来**：换算之后公斤与磅在 `workouts` 里完全相同，
   * 事后从 weight 反推是不可能的。没有磅时是 0，不是 undefined。
   */
  poundsConverted: number;
}

export function parseWorkoutCsv(text: string): CsvParseResult;
```

> 实施后补记：`poundsConverted` 是设计时漏掉的字段。预览页那句「已把 N 行磅换算成公斤」
> 是这一节明确要求的，但最初的接口里没有任何字段能承载这个计数，等于把这件事
> 推给界面自己扫文本去数（判据会和解析器不一致）。已补进接口并由解析器负责。

**列名映射表**（表头先按规范化后的名字匹配，三种来源各一张）：

| 来源 | 日期 | 训练名 | 动作 | 组序 | 重量 | 次数 |
|---|---|---|---|---|---|---|
| Strong | `Date` | `Workout Name` | `Exercise Name` | `Set Order` | `Weight` | `Reps` |
| Hevy | `start_time` | `title` | `exercise_title` | `set_index` | `weight_kg` | `reps` |
| 训记 | `日期` | `训练名称` | `动作名称` | `组序号` | `重量(kg)` | `次数` |

只有「日期 / 动作 / 重量 / 次数」四列是**必需**的；训练名与组序缺失时分别退化成 `null` 和「按行序编号」。

**必须处理的脏数据，每一条一个测试用例：**

| 输入 | 期望 |
|---|---|
| UTF-8 BOM 开头 | 首列名不带 `\uFEFF`，能匹配上 |
| `\r\n` 换行 | 不把 `\r` 带进字段值 |
| 字段里有逗号、有引号：`"卧推, 上斜"` | 正确解析成一个字段，引号内的逗号不当分隔符 |
| 重量带单位：`60kg` | 60 |
| 重量是磅：`135 lb` | 61.23…（保留两位；**不静默换单位**，预览里写明「已把 N 行磅换算成公斤」） |
| 自重：`BW` / 空 | 记 0 kg，**不算读不懂**（次数仍是有效数据） |
| 日期 `2024-01-15 09:30:00` / `2024/1/15 9:30` / `1/15/2024 9:30 AM` | 都能解析成毫秒时间戳 |
| 只有日期没有时间 | 当天 **12:00 本地时间**（不是 00:00：零点最容易被时区处理推到前一天） |
| 空行、重复表头行 | 跳过，且**不计入 skipped**（它们不是「读不懂」） |
| **每一行都读不懂**（选错了文件、或者是别的格式） | `workouts` 为空 → 预览页直接显示「这个文件里没有能识别的训练记录」并只给「取消」，**不给「确认导入」按钮** |

**解析层绝不猜。** 认不出的行进 `skipped`，带行号和原因（如「第 37 行：日期的格式认不出来（收到 `15/1/24 上午9:30`）」）。行号用**文件里的真实行号**，用户能直接对着表格找。

### 5.3 `src/domain/importRecords.ts`

```ts
/** 与来源格式无关的中间结构。CSV 解析与手动补记录都产出它 */
export interface ImportedWorkout {
  startedAt: number;
  finishedAt: number;
  name: string | null;
  exercises: { name: string; sets: { weight: number; reps: number }[] }[];
}
```

这一层负责从中间结构组装出实体（`session` / `sessionExercise` / `set` 的对象数组，id 用 `newId()`），并做**写库前**就该做完的检查：起止时间是否合法（`finishedAt >= startedAt`）、有没有一个动作一组都没有。它不碰数据库，所以这些检查在单测里跑得飞快。

**没有动作、或所有动作一组都没有的「训练」一律拒绝**，理由与 `2026-09-21` 那份设计一致：空训练进了库就是一条点开什么都没有的历史记录，用户既看不懂也删不掉（除非再点一次删除）。CSV 里这种行是解析不出组的坏数据，手填时是用户还没填完就点了保存——两种都该拦在写库之前。

---

## 6. 界面

### 6.1 训练页 `app/(tabs)/index.tsx`：顶部显示今天练什么

**有进行中的训练** —— 保持现在的样子（`进行中` 卡片 + 主按钮「继续训练」）。这一屏在健身房里被打开的那一瞬间，用户要的是「回到刚才那场」，任何新东西都不许挤到它前面。

**没有进行中的训练** —— 主按钮上方加一张计划卡片：

```
今天该练

拉日                      第 2 / 3 套
背 等 6 个动作

[        开始训练        ]
[        换一个计划       ]     ← ghost 按钮
```

- 卡片上的计划名与「背 等 6 个动作」用现成的 `describeExercises`（`src/lib/sessionLabel.ts`）拼，不新写一套描述逻辑。
- 点「开始训练」直接开，**不弹窗问练哪套**（用户已确认：选了分化循环就是要它自动轮转）。
- 点「换一个计划」弹一个计划列表（`Alert` 只支持三个按钮，套数不定，所以这里用 `Modal`），每项旁边标注「下一步轮到」；选中后**立刻把这一场的 `template_id` 写进库**。这样轮转指针真的跟着动，而不是下一场又弹回来。
- **没有建过任何计划**时这张卡片整个不渲染，文案回到现在的「会沿用上次的动作清单，直接接着练」——老用户升级后行为不变，不会突然拿到一场空训练。

### 6.2 记录页 `app/session/[id].tsx`：删动作

顶部动作条下方加一行，只在 `exercises.length > 1` 时显示：

```
[ 删除「深蹲」 ]        ← ghost 变体，与「结束训练」同一档
```

点击后分两条路（用户已确认的规则）：

| 条件 | 行为 |
|---|---|
| 该动作**没有任何 `is_completed = 1` 的组** | 直接删，不弹窗 |
| 已经记过组 | 弹窗：**「深蹲」已经记了 3 组** / `[删掉这 3 组] [先留着] [取消]` |

- 「删掉这 3 组」→ `deleteSessionExercise`（组与动作一起消失，`position` 重排）
- 「先留着」→ `deleteIncompleteSetsOf`：**删掉未完成的占位组，保留已完成的组**，动作那一行留在库里。界面按「**这个动作还有没有未完成的组**」把它从记录页摘掉；而进步曲线只认「已完成且属于某场训练」的组，那 3 个点仍在曲线上——**这是刻意的**：用户选的是「别删我的记录」，只是不想这场里再有这个动作。
  > 判据必须是「还有没有**未完成**的组」，不能是「一行 set 都没有」：保留已完成组之后，被摘掉的动作在库里并不是空的。而「还有未完成的组」正是记录页能记下一组的条件（`addExerciseWithFirstSet` 预建第一组、`completeCurrentSet` 完成后立刻预建下一组）——两边用同一条判据，才不会出现「动作条里有它、屏幕上却记不了」的状态。
  > 未完成的占位组**必须**一起删掉：`completeCurrentSet` 每完成一组都会预建下一组，留着占位组，它下次 `resume` 回来时用户点「完成这组」会毫无反应——一个静默的假死按钮。
- 「取消」→ 什么都不做

**`exercises.length === 1` 时不显示这个按钮**，避免把最后一项删成空屏。真要在空屏上重来，用户还有「结束训练」——而删光动作再练没有任何意义。

`store.removeExercise(exec, sessionExerciseId)` 的职责：
1. 已结束的训练（`finishedAt !== null`）静默返回（沿用现有防御闸门的写法）；
2. 按参数决定删组还是留组；
3. 重新 `loadExercises`；
4. **把 `currentIndex` 夹回合法范围**（`Math.min(currentIndex, exercises.length - 1)`，并在列表为空时归 0）。

> 第 4 条不做就是一个崩溃点：删掉的正好是当前聚焦的那个动作时，`exercises[currentIndex]` 变成 `undefined`，记录页会掉进「这次训练还没有动作」的分支，而那时 store 里其实还有别的动作。这个动作条与屏幕内容对不上的状态，比崩溃更难排查。

### 6.3 设置页：计划管理

设置页加一张「训练计划」卡片，位置在「外观」与「备份」之间（三张卡片都是配置，视觉上连成一组）：

```
训练计划
编排你的分化循环，开始训练时会按顺序自动轮转。

拉日        6 个动作   ↑ ↓
推日        5 个动作   ↑ ↓
腿日        7 个动作   ↑ ↓

[ ＋ 新建计划 ]
```

点一行进编辑页（`app/plan/[id].tsx`，`id === 'new'` 表示新建）：

- 顶部一个名字输入框（默认「新计划」，进入即选中全文，直接打就能改名）
- 动作清单：每行动作名 + 上移/下移/删除
- 底部「＋ 添加动作」→ **复用抽出来的 `ExercisePickerModal`**
- 右上「保存」→ `setTemplateExercises` 整体覆盖；有未保存改动时按返回键弹「放弃修改？」

### 6.4 历史页：删记录

两处入口，都二次确认：

- **列表左滑**（`app/(tabs)/history.tsx`）：用 `react-native-gesture-handler` 的 `Swipeable`，右侧露出红色「删除」。这个库已经在依赖里（`~2.32.0`），但**实施第一步先确认它的导出面**——v2 里 `Swipeable` 的位置在 `react-native-gesture-handler` 不同版本间搬过家（含 `ReanimatedSwipeable` 变体）；如果当前版本没有合适的组件，就退化成每行右侧一个常驻的小「⋯」按钮，功能一样，不为此引入新依赖。
- **详情页**（`app/history/[id].tsx`）：「删除这条记录」用 `danger` 变体（与设置页「导入备份」同一档视觉语义）。

文案必须写明后果，不能只说「确认删除？」：

> **删除 9月16日 19:30 的训练？**
> 这条记录和它的 12 组会一起消失，进步曲线上也会少掉这一个点。删了不能恢复。

**删的正好是进行中的那一场时**：删完立刻 `useActiveSession.getState().reset()`。不清的话，首页「继续训练」会指向一条已经不存在的记录，点进去是一屏空白——这正是 `2026-09-21-workout-lifecycle-design.md` 修过的那类 bug，不能重新引入。详情页删除后 `router.back()` 回历史列表。

### 6.5 记录管理页 `app/import/index.tsx`：CSV 导入与手动补记录

设置页加一张「记录管理」卡片（放在「备份」下面，与它同属「数据进出的地方」）：

- **从其他 App 导入** → `expo-document-picker` 选文件 → 解析 → **预览页**
- **手动添加一条记录** → 同一个路由的另一个模式

**预览页**（导入的必经之路，用户已确认）：

```
准备导入 42 场训练

时间范围    2023-04-08 ~ 2024-01-12
涉及动作    18 个，其中 3 个本机没有
            （将新建为自定义动作：坐姿划船机、史密斯卧推、农夫走）
单位换算    12 行的磅已换算成公斤
读不懂      7 行会被跳过          [展开看是哪几行]

[ 确认导入 ]   [ 取消 ]
```

- 展开后逐行列出「第 37 行：日期的格式认不出来（收到 `15/1/24 上午9:30`）」。
- 「确认导入」时按钮进 `loading` 并禁用——导入要写几百行，重复点击会跑第二遍。
- 成功/失败用 `Alert`：成功写清「导入 42 场、18 个动作（其中 3 个是新建的）」；失败写清原始错误（`importRepo` 抛的是原始异常，事务已回滚，库里没变）。

**手动补记录**（表单，与 CSV 导入产出同一种记录）：

1. 日期 + 时间，默认现在
2. 训练名（可空，占位文字「未命名训练」）
3. 逐个加动作：复用 `ExercisePickerModal`
4. 每个动作下面一行行填「重量 × 次数」（`Stepper` 复用），默认 20 kg × 8
5. 时长（分钟），默认 45 → 决定 `finished_at`
6. 右上「保存」→ 走**同一个** `importRepo` 落库路径（只是 `workouts` 数组里只有一场）

第 6 条是刻意的：CSV 与手填是两种输入方式，落库必须只有一条路径。两条路径的差别一旦出现（比如一边写了 `completed_at`、另一边忘了），进步曲线会莫名其妙地少点，而这种 bug 极难定位。

### 6.6 备份格式 1 → 2

`src/domain/backup.ts`：

- `BACKUP_VERSION` 从 1 改成 2；`BackupData` 加 `templates: SplitTemplate[]` 与 `templateExercises: TemplateExercise[]`。
- **`version 1` 的老备份必须仍能导入**：`templates` / `templateExercises` 缺失时按**空数组**处理，`session.templateId` 缺失时按 `null` 处理。不做这条兼容，用户手上已经导出的备份文件就当场作废——那是比新功能没做更严重的问题。
- `version > 2` 仍然拒绝（这条现有逻辑不动）。
- `validateBackup` 的引用完整性检查增加两条：`templateExercise.templateId` 必须在 `templates` 里、`templateExercise.exerciseId` 必须在 `exercises` 里。
- `backupRepo.exportAll` 按 `rowid ASC` 多导两张表；`importAll` 的删除顺序在前面插入 `template_exercise → split_template`（必须在 `exercise` 之前，因为 `template_exercise.exercise_id` 引用 `exercise(id)`），插入顺序在 `exercises` 之后。

---

## 7. 测试

### 7.1 新增的纯函数测试

| 文件 | 覆盖 |
|---|---|
| `src/domain/rotation.test.ts` | §5.1 的四条边界 |
| `src/domain/csv.test.ts` | §5.2 表格里的每一种脏数据 + 三种来源各一份最小样本 + `skipped` 的行号与原因 |
| `src/domain/importRecords.test.ts` | 中间结构 → 实体：时间非法、空动作、同名动作合并、id 唯一 |
| `src/domain/backup.test.ts`（扩） | version 1 老备份可导入且模板为空；version 2 正常；`templateExercise` 的孤儿引用被拒 |

### 7.2 仓储与 store 测试

| 文件 | 用例 |
|---|---|
| `src/repositories/templateRepo.test.ts`（新） | CRUD；`setTemplateExercises` 整体覆盖后顺序正确；删除计划后 `session.template_id` 被置空、剩余 `position` 无空洞 |
| `src/repositories/importRepo.test.ts`（新） | 同名动作**只建一次**（断言 `exercise` 表新增行数 = 1）；同一场里同名动作合并成一个 `session_exercise`；导入的场次出现在 `listSessionSummaries` 与 `listCompletedSetPoints` 里；**中途失败整体回滚**（构造一条引用不存在动作的记录，断言库里场数与动作数都没变） |
| `src/repositories/sessionRepo` 相关（扩） | `deleteSession` 连带删掉 `session_exercise` 与 `set_entry`（断言三个表的行数）；删掉进行中的那一场后 `getActiveSession` 返回 `null`；`deleteSessionExercise` 后剩余 `position` 连续；`deleteIncompleteSetsOf` 只删未完成的占位组、已完成的组与动作那一行都留着 |
| `src/store/activeSession.test.ts`（扩） | `removeExercise` 后 `currentIndex` 被夹住（删的正好是当前动作时不出现 `undefined`）；删掉进行中的那一场后 `resume` 返回 false 且库里 `finished_at IS NULL` 计数为 0（沿用既有的不变量测试写法）；`startNew` 在有计划时用轮转结果、无计划时沿用旧逻辑 |

### 7.3 迁移测试

`src/db/migrations.test.ts`（扩）：从 v2 的库跑 `migrate` 到 v3，断言 `split_template` / `template_exercise` 存在、`session` 有 `template_id` 列；再跑一次 `migrate` 无副作用（幂等）。

### 7.4 真机验收

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 建「推/拉/腿」三套计划 → 连开三场 → 第四场 | 动作清单依次是推、拉、腿、推 |
| 2 | 第二场里删掉一个**没记过组**的动作 | 直接消失，不弹窗 |
| 3 | 删掉一个**记过 2 组**的动作，选「删掉这 2 组」 | 动作消失，剩余顺序不乱，进步曲线上那 2 组消失 |
| 4 | 同上，改选「先留着」 | 记录页里消失，历史里这场仍显示原有组数，曲线上的点还在 |
| 5 | 一场只有一个动作时 | 「删除」按钮不显示 |
| 6 | 删掉的正好是当前聚焦的动作 | 停在相邻动作上，**不出现「这次训练还没有动作」** |
| 7 | 历史列表左滑删一条 → 详情页删一条 | 列表少一条、进步曲线少一个点 |
| 8 | 删当前**进行中**的那一场 | 首页不再出现「继续训练」 |
| 9 | 导一份别的 App 的 CSV | 预览的场数/动作数/跳过行数与实际一致；确认后历史与曲线都能看到 |
| 10 | 手动补一条去年的记录 | 立刻出现在进步曲线最早那一端 |
| 11 | 用**旧版本导出**的备份文件导入 | 成功，计划列表为空，训练记录完整 |
| 12 | 计划列表里把「腿日」上移一位 → 看首页 | 轮转顺序跟着变 |

---

## 8. 明确不做

- **计划里不存目标组数/重量/次数**（§2.2 的理由）。
- **不做拖拽排序**：计划的顺序用上移/下移按钮。拖拽要引入手势与动画的复杂度，而它换来的只是「少点几下」，且两个界面（计划编辑、记录页动作条）都要做一遍。
- **训练中不改动作顺序**：只加、只删。临时调顺序的价值小于它带来的手势复杂度。
- **不做云端同步、不做多设备**：本 App 的定位是单机。
- **不做「跳过今天这套」的独立按钮**：「换一个计划」就是它（§6.1）。
- **不做时间上限、不做「上次训练超过 N 天就重置轮转」**：沿用 `2026-09-21` 那份设计 §2.4 的结论——把状态机做对，比替异常状态加兜底更准。

---

## 9. 已知限制

**网页预览（`database.web.tsx` + `demoExecutor.ts`）看不到新功能的效果。** 那个内存执行器按 SQL 形态分发，不是 SQL 引擎（文件开头的注释写明了这一点）。它现有的两条分支会直接吃掉我们的新语句：

- `DELETE FROM session WHERE id = ?` 会先命中 `demoExecutor.ts:334` 的「清空整表」分支；
- `templates` / `template_exercises` 是新表，`INSERT INTO split_template` 会落进 `未知的表` 警告并静默丢弃。

也就是说，**在网页预览里，删记录、计划管理、导入都是「点了没反应」**。三条路可选：

1. 真机验收（本设计的验收表就是这么写的）；
2. 给 `demoExecutor` 补上这几条语句的分发——它是「按形态匹配」的写法，补一条新语句就要补一条分支，成本随功能增长；
3. 在 web 上把这三处入口隐藏掉，预览里不出现点不动的按钮。

**推荐第 3 条**：预览的价值是看界面，不是一个点不动的按钮。实施时在 `Platform.OS === 'web'` 下隐藏这三个入口，并在 `demoExecutor.ts` 开头的说明里加一句「哪些功能预览里不可用」。这件事**单列一个小任务**，不要混在功能实现里。

**落实记录（Task 17）**：选了第 3 条。四个界面 import 同一个常量 `isWebPreview`，没有把判断散在各处：`app/(tabs)/history.tsx` 不渲染行内的「删除」按钮，`app/history/[id].tsx` 不渲染底部的「删除这条记录」，`app/(tabs)/settings.tsx` 的「训练计划」与「记录管理」两张卡片整个不渲染（改为在「备份」卡片里加一句只在 web 上显示的说明），`app/(tabs)/index.tsx` 在取计划那个 effect 的入口早退，并把 `templates` / `plannedId` / `plannedNames` 一并设成「没有计划」的那组值。`demoExecutor.ts` **只改了文件头的说明**，一条分发分支都没补 —— 那个假库不值得为预览再补一套 SQL 分支。

> **实施时的一处修正：常量不能用 `Platform.OS === 'web'` 写在单个文件里。**
> 那需要 `import { Platform } from 'react-native'`，而 react-native 的入口是 ESM ——
> jest 的 `testEnvironment` 是 `node`，加载不了它，于是**任何间接 import 这个常量的
> 模块都会在测试里炸**（实测：`src/store/activeSession.ts` 引了它，整个
> `activeSession.test.ts` 直接跑不起来）。
>
> 改成**平台解析**：`src/lib/preview.ts` 里 `isWebPreview = false`（无任何 import，
> node 下安全），`src/lib/preview.web.ts` 里为 `true`，Metro 打包时优先取 `.web.ts`。
> 这与仓库里 `repositories/database.tsx` / `database.web.tsx` 用的是同一套机制。
>
> `src/store/activeSession.ts` 里也补了一处早退：`startNew` 内部同样会查
> `listTemplates` / `findLatestTemplateId`，只处理界面那一处的话，预览里按一次
> 「开始训练」仍会刷一条「未处理的查询」警告。两处都要有 —— 少任何一处，
> 警告还是会从另一个入口冒出来。

**真机验收：一项都没做，全是「未做」。** 这次收尾所在的机器上 `adb devices` 是空的（没有连接任何设备），所以 §7.4 那张表的 **12 项全部未做**，不只是「本来就要在手机上跑」的那几项。上面这些改动只经过 `npx tsc --noEmit` 与 `npx jest`（25 个测试文件 / 304 条断言，全绿）的**静态自查**；**静态自查不等于验收**，它不代表任何一项已经在真机上通过，也不能替代上面第 1 条那条路。

**补做的一层验证：端到端回归（`npm run verify:e2e`）。**

实施过程中发现一个覆盖盲区：`src/` 下的 304 条断言**全部是分层的**（仓储测仓储、store 测 store、纯函数测纯函数），而**没有任何一个测试覆盖「用户实际走的那条链」**。例如「按计划开训练 → 练完 → 结束 → 再看轮转」跨了 `domain/rotation` / `templateRepo` / `sessionRepo` / `setRepo` / `store/activeSession` 五处。分层全绿仍然可能因为层与层之间的假设不一致而整体坏掉。

于是补了 `verify/e2e.test.ts`：在真实 SQLite（`node:sqlite`）上把五条主旅程串起来跑，33 项断言。它跑在 `src/` 之外，所以 `npx jest` 不会带上它（不拖慢日常反馈），需要时用 `npm run verify:e2e`。

| 旅程 | 断言要点 |
|---|---|
| 分化轮转 | 连开四场依次用 推/拉/腿/**推**（真的绕回）；按计划开的那一场动作清单就是计划里的那几个 |
| 训练中删动作 | 两条分支的结果；**记过 2 组的动作选「先留着」后仍从记录页消失、而那 2 组仍在库里、占位组被删掉**；删完 `position` 重排成 0,1；历史里组数正确 |
| 导入旧记录 | 导入 3 场后深蹲曲线上的点 = 本机 2 + 导入 6，且**最早的点是旧记录的时间**；只新建 1 个自定义动作；删掉其中一场后曲线少 2 个点 |
| 不建计划的用户 | 行为与升级前逐项一致（复制上一次的动作、`templateId` 为 null）；删一场不影响另一场 |
| 删计划 | 上移真的换位；删计划后历史仍在、只是不再指向任何计划、`position` 无空洞；下一场轮转回到第一套 |

它**不覆盖**渲染、手势、原生模块，也覆盖不到真机上 `expo-sqlite` 与 `node:sqlite` 的实现差异 —— **不能替代真机验收**。

> 这条链第一次跑就抓出了一个分层测试没抓到的问题：`keep` 之后「已记过组的动作」
> 摘不掉。根因是判据写成了「这个动作一行 set 都没有」，而 `keep` 会**保留**已完成的组，
> 条件恒不成立 —— 当时分层测试里那条用例也写错了同一个判据，两边同时错的时候只有
> 端到端能发现。这也是它值得留在仓库里的理由。

---

## 10. 实施拆分

一次做完是一份太大的改动。按「每一段单独可用」拆成三轮，每轮各自有设计里已定义的验收项：

**M6 · 计划与轮转**（验收 1、12）
schema v3 + `templateRepo` + `domain/rotation` + 设置页计划管理 + `startNew` 走轮转 + 首页计划卡片 + 备份格式 1→2。

**M7 · 删除**（验收 2~8）
`deleteSession` / `deleteSessionExercise` / `deleteIncompleteSetsOf` + `removeExercise` + 记录页删除按钮与两条分支 + 历史页左滑与详情页删除 + 进行中那一场的 store 清理。

**M8 · 导入**（验收 9~11）
`domain/csv` + `domain/importRecords` + `importRepo` + `ExercisePickerModal` 抽取 + 导入预览页 + 手动补记录表单。

顺序不可颠倒：M8 的预览页要显示动作名，而动作名来自已经存在的动作库；M7 的删除要先有 M6 的迁移（`session` 表的改动在同一次迁移里，分开做要写两次 v3）。

---

## 11. 影响范围

| 文件 | 改动 |
|---|---|
| `src/db/schema.ts` / `migrations.ts` / `types.ts` | 两张新表 + `session.template_id`；迁移 v3；`SCHEMA_VERSION` → 3 |
| `src/domain/types.ts` | `WorkoutSession` 加 `templateId`；新增 `SplitTemplate` / `TemplateExercise` |
| `src/repositories/templateRepo.ts`（新） | §4.1 |
| `src/repositories/importRepo.ts`（新） | §4.3 |
| `src/domain/rotation.ts`（新） | §5.1 |
| `src/domain/csv.ts`（新） | §5.2 |
| `src/domain/importRecords.ts`（新） | §5.3 |
| `src/repositories/sessionRepo.ts` | `deleteSession`、`deleteSessionExercise`、`deleteIncompleteSetsOf`、`findLatestTemplateId`、`template_id` 进列清单、`createSession` 多一个参数 |
| `src/repositories/backupRepo.ts` / `src/domain/backup.ts` | 模板两表进出备份；`BACKUP_VERSION` → 2；**version 1 仍可导入** |
| `src/store/activeSession.ts` | `removeExercise`；`startNew` 改为轮转优先、无计划时沿用旧逻辑；`currentIndex` 夹取 |
| `src/components/ExercisePickerModal.tsx`（新） | 从 `app/session/[id].tsx:294-366` 抽出，训练页与手动补记录共用 |
| `app/(tabs)/index.tsx` | 计划卡片、换计划弹层 |
| `app/session/[id].tsx` | 删除动作入口 + 两条分支的弹窗；改用抽出的选动作弹层 |
| `app/(tabs)/history.tsx` | 左滑删除 |
| `app/history/[id].tsx` | 删除记录按钮 |
| `app/(tabs)/settings.tsx` | 计划管理卡片、记录管理卡片 |
| `app/plan/index.tsx` / `app/plan/[id].tsx`（新） | 计划列表与编辑 |
| `app/import/index.tsx`（新） | 导入预览 + 手动补记录 |
| `app/_layout.tsx` | 三条新路由；`plan/*` 用原生导航栏，`import` 用原生导航栏 |
| `src/db/demoExecutor.ts` | 见 §9：隐藏入口 + 文件头补一句说明 |
