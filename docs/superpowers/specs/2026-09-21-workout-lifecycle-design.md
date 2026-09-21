# 训练生命周期 —— 设计文档

- **日期**：2026-09-21
- **状态**：已与用户确认，待实施
- **项目目录**：`C:\ccproject\gym`
- **一句话**：把「进行中的训练」做成一处状态机 —— 库里最多只有一条未结束的训练，而它只可能来自进程被非正常终止。

---

## 1. 问题

### 1.1 用户看到的现象

1. 主页的「继续上次训练」**不管什么情况都在**；
2. 点进去**永远是一样的界面**；
3. 而且**永远从深蹲开始**；
4. 用户的原话：*「第三次了我还接着第二次训练去练。」*

### 1.2 根因

用户对功能的预期是**明确**的：

> 「只会在训练过程中软件被误杀才需要这个功能……每次练完不是都会结束吗？」

也就是说，一次训练的生命周期本该是「开始 → 练 → 结束」。**但这个规则在代码里没有被真正执行**，一共四处漏：

| # | 漏洞 | 位置 | 后果 |
|---|---|---|---|
| 1 | 「结束训练」写了 `finished_at`，但**不清内存**。清内存的 `reset()` 只挂在总结页的「保存这次训练」上 | `app/session/summary/[id].tsx:49` | 结束训练后用系统返回键离开总结页 → 库里已结束、内存里还在 → 主页照样显示「继续上次训练」，指向一场**已经结束**的训练 |
| 2 | 主页只看 `session` 存不存在，**不看 `finishedAt`** | `app/(tabs)/index.tsx:38` | 上面那条内存泄漏会直接变成界面上的按钮 |
| 3 | `startNew` **完全不碰**旧的未结束训练 | `src/store/activeSession.ts:155` | 每点一次「开始新训练」就多留一条未结束记录；旧的会一直挂着，等新的结束之后又冒出来 |
| 4 | 已结束的训练**没有写保护**：记录界面只比对 id | `app/session/[id].tsx:101` | 从按钮绕进一场已结束的训练后，能继续往里记组 —— 同一场训练被接上了第二次、第三次 |

还有第五处，只影响「为什么总是深蹲」：

| # | 漏洞 | 位置 | 后果 |
|---|---|---|---|
| 5 | `resume` 永远把 `currentIndex` 设成 0 | `src/store/activeSession.ts:148` | 数据里根本没有「练到第几个动作」，不管在第几个动作离开，回来都是第一个动作 |

**证据（2026-09-21 实测）**：临时 Jest 复现脚本，把「练完第一场 → 第二场练一组就走人 → 第三场正常练完并保存 → 回主页」跑一遍，`resume` 指向的是**第二场那场早就放弃的训练**，不是刚保存的第三场。另有一条：`endWorkout` 之后 store 里那条 `finishedAt` 非空，而主页判定 `session !== null` 为真 —— 按钮必然出现。脚本跑完已删除。

### 1.3 附带发现：手机上的包是旧的

`.superpowers/gym-tracker-preview.apk` 的下载完成时间是 2026-09-16 19:43:33；EAS 云构建实测上传 25 秒、构建约 20 分钟 → 上传发生在 19:24 前后，即提交 `2060b62` 那一版。

而「每次新训练都从深蹲开始」的修复是 19:59 的 `7ce93e6` —— **在打包之后**。那一版的 `startNew` 就是：

```ts
const first = all.find((e) => e.name === '深蹲') ?? all[0];
```

`docs/superpowers/plans/2026-09-16-m5-backup.md:228` 那条「重新打包 APK」至今未打勾，与该推断一致。

**所以第 3 条现象（总是深蹲）有一半来自旧包，一半来自漏洞 5。** 本设计修的是后者；前者要靠重新打包解决（见 §8）。

---

## 2. 语义与不变量

### 2.1 术语

- **进行中的训练**（current）：`session` 表里 `finished_at IS NULL` 的那条记录。
- **当前训练**：store 里 `session` 非空且 `finishedAt === null` 的那场。界面上说「继续上次训练」，指的一律是它。

### 2.2 不变量

> **`SELECT COUNT(*) FROM session WHERE finished_at IS NULL` 永远 ≤ 1，
> 而且这条记录只可能由「进程被非正常终止」产生。**

这条不变量一旦成立，用户的三个抱怨会同时消失：按钮只可能在真有没练完的训练时出现，而且那一场必然就是他要接着练的那场。

### 2.3 状态转移

| 触发 | 动作 | 结果 |
|---|---|---|
| 被误杀 / 强杀 | **什么都不做** | 库里留下唯一一条 current；下次启动 `resume` 捡回来 |
| 点「结束训练」 | 写 `finished_at` **并立即清空内存** | 进历史；主页从此不再出现「继续」 |
| 存在 current 时点「开始新训练」 | **不新建**，返回冲突 → 界面问一句 | 「接着练」= 进那场；「结束它，开始新的」= 先 `endWorkout` 再建新的 |

第三行是这次修复的核心：**「开始新训练」永远不能产生第二条未结束记录。**

### 2.4 为什么不需要时间上限

曾考虑「最后一次记录超过 N 小时就作废」或「每次冷启动都问一句」。都不做，理由是用户的实际流程：

> 每次练完都会点「结束训练」，所以正常流程下**根本不会**留下未结束的训练 —— 会留下的只有误杀。

时间上限和每次询问都是在替一个不该出现的状态做兜底。把「结束」变成不可逆的（§2.3 第二行）比加时间判断更准确、也不需要用户多点一下。

---

## 3. store 接口（`src/store/activeSession.ts`）

### 3.1 签名

```ts
type StartResult = 'started' | 'conflict';

resume(exec): Promise<boolean>              // 不变
startNew(exec, name): Promise<StartResult>  // 变了：有 current 时返回 'conflict'，且不建新记录
endWorkout(exec): Promise<string | null>    // 变了：返回刚结束的那场的 id（没有当前训练时 null），并立即清空 store
addExercise / completeCurrentSet / beginNextSet   // 签名不变，内部加一道 finishedAt 防御
reset(): void                               // 不变（导入备份时仍要用）
```

### 3.2 `startNew` 撞上 current 时怎么办

实现只有三行，且复用同一条装载路径：

```ts
if (await get().resume(exec)) return 'conflict';  // 库里已经有一场进行中的：把它装进 store，交回界面
const session = await createSession(exec, name);
// ……沿用上一次已结束训练的动作组合（现有逻辑不动）
return 'started';
```

**冲突时必须把那一场装进 store（而不是只返回一个 id）**，两个原因：

1. 界面选「接着练」后直接导航到 `/session/[id]`，记录页的 effect 看到 `session.id === id` 就不会再 `resume`；store 里没有 `exercises` 的话，那一屏会误判成「这次训练还没有动作」，给用户一个空的记录界面。
2. 界面选「结束它，开始新的」要调 `endWorkout`，而它作用于 store 里的那场。

顺带修掉一个竞态：主页刚挂载、`resume` 还没跑完时用户就点了「开始新训练」，旧写法会漏判并建出第二条未结束记录；新写法不会。

### 3.3 `endWorkout` 立刻清内存，为什么安全

- 总结页的 `SessionSummaryView` 按路由参数 `id` **从库里读**，不依赖 store。
- 清空之后 store 就是「没有当前训练」，与库里的状态一致；不存在「已经结束但还是当前」的中间态。

实现上是写完 `finished_at` 后直接调 `reset()`，并返回被结束的那场的 id。

### 3.4 `resume` 恢复练到哪个动作

不再写死 `currentIndex: 0`，改为从库里推：

> 取这场训练里**最近有动作的那一组**，即 `completed_at` 最大的那一组，它归属的 `session_exercise` 在动作列表里的下标，就是当时在练的动作。一组都没完成 → 0。

正在休息的那种情况自动落在同一个答案上：`startRest` 就是在 `completeSet` 之后对**同一组**调用的，所以「正在休息的那一组」和「`completed_at` 最大的那一组」必然是同一组，不需要第二条判定。

**纯查询，不加字段、不做迁移。** 覆盖两种离开方式：做完一组在休息（`rest_started_at` 有值）和休息结束正在填下一组（`completed_at` 是上一组）。已知不精确的只有一种：切到第 4 个动作但一组都没做就被杀 —— 会回到第 3 个动作。可以接受。

### 3.5 防御性闸门

`addExercise` / `completeCurrentSet` / `beginNextSet` 入口处加一句「`session.finishedAt !== null` 就直接返回」。正常情况下 `endWorkout` 已清空 store、`session` 为 null，现有代码本来就会 return；这一层是防将来有人把已结束的训练塞回 store —— §1.2 漏洞 4 就是这么来的。

---

## 4. 界面

### 4.1 主页 `app/(tabs)/index.tsx`

**显示条件**改为：

```ts
const resumable = session !== null && session.finishedAt === null;
```

**按钮写明是哪一场**，不再是光秃秃的一句「继续上次训练」：

> **继续 9月16日 19:30 的训练**
> <sub>深蹲 等 3 个动作 · 已记 12 组</sub>

- 数据 store 里现成：动作数 = `exercises.length`，已记组数 = 所有 `sets` 里 `isCompleted` 的数量，第一个动作名 = `exercises[0].exerciseName`，时间 = `session.startedAt`。**不需要新查询。**
- 一个动作时写「深蹲 · 已记 3 组」；一个动作都没有时写「还没有动作」。
- 这个描述串在同一个文件里抽成一个局部函数，按钮与下面的询问弹窗共用（两处必须永远一致）。

**「开始新训练」拿到 `'conflict'`** 时弹（三个按钮正好是 Android Alert 的上限）：

> **上一场训练还没结束**
> 9月16日 19:30 · 深蹲 等 3 个动作 · 已记 12 组
> \[接着练] \[结束它，开始新的] \[取消]

- 「接着练」→ 进那一场（等同于点「继续」）。
- 「结束它，开始新的」→ `endWorkout` → `startNew` → 进新的。
- 「取消」→ 什么都不做，留在主页。
- `startNew` 是异步的，弹窗之前用现有的 `loading` 再挡一道重复触发。

**共用日期格式**：`formatDate` 现在埋在 `app/(tabs)/history.tsx` 里，抽到 `src/lib/format.ts`，历史页改用抽出来的那个，不再留第二份实现。

同文件里再加一个主页专用的 `formatDateTime`，输出带时分、且同一天内一眼能认出来：

| 情况 | 输出 |
|---|---|
| 今天 | `今天 15:20` |
| 昨天 | `昨天 19:30` |
| 更早 | `9月16日 19:30` |

它直接服务于用户最初那个问题 ——「上次到底是哪一次」。`formatDate`（历史用，`9月16日 周三`）保持不变。

### 4.2 记录页 `app/session/[id].tsx`

- **写保护**：`session.finishedAt !== null` → 不渲染记录界面，显示「这场训练已经结束」+ 回主页按钮。
- **空态**：store 空、库里也没有 current 时（深链进一个不存在的 id），现在会永远停在「载入中…」。改成 effect 里 `await resume()` 之后再判断，给出明确的「这场训练不存在或已结束」+ 回主页。
- **防闪帧**：结束训练时 `endWorkout` 会先清空 store，而 `router.replace` 在其后。用一个本地 `finishing` 状态挡住这一帧，避免闪过空态。

### 4.3 总结页 `app/session/summary/[id].tsx`

- 「保存这次训练」→ **「完成」**。因为「结束训练」那一下已经落盘，这个按钮不再负责写库，只做 `releaseScreenAwake()` + `router.replace('/(tabs)')`，也不再需要 `reset()`（store 已空）。

  **"结束了但没保存"这个中间态就此消失** —— 它正是 §1.2 漏洞 1 的来源。

- **兜底加锁**：现有那句 `finishSession(exec, id, Date.now())` 是**无条件覆盖** `finished_at` 的，会把结束时间往后推。改成先 `getSession(exec, id)`，只有这场确实 `finishedAt === null` 才写。它覆盖的场景是「强杀后经深链直接进总结页」。

### 4.4 不做什么

- 不加时间上限（§2.4）
- 不加独立的「放弃这场训练」按钮 —— 「结束它」就是它，且会进历史，不丢数据
- 不加 session 状态字段、不做迁移
- 不动备份格式（备份里进行中的训练照旧导出，导入后 `resume` 能接回来）
- 不动历史列表（进行中的训练仍然不进历史）

---

## 5. 测试

**不变量**（store 层，`src/store/activeSession.test.ts`）

- 任意操作序列之后：`SELECT COUNT(*) FROM session WHERE finished_at IS NULL` ≤ 1
- `startNew` 撞上 current → 返回 `'conflict'`，且库里**没有**新增 session；store 里装的是那一场
- `endWorkout` 之后：store 立刻为空、库里 `finished_at` 非空、紧接着 `startNew` 返回 `'started'`
- `resume` 恢复 `currentIndex`：造「动作 A 做完 2 组、动作 B 做完 1 组」→ resume 后停在 B
- 已结束的训练：`completeCurrentSet` 不再产生新组

**回归**（把这次的复现固化）

- 练完一场并保存 → `resume` 返回 `false`，主页拿不到可继续的训练
- 「结束训练后没点保存就退出」这个场景：`endWorkout` 之后 store 必须为空（这条在改动之前必然是红的）

**既有测试的预期改动**：`startNew` 现在会先查一次 current，凡是「先造一场未结束的训练、再调 `startNew`」的用例都会拿到 `'conflict'` —— 现有 `src/store/activeSession.test.ts:179`「还在进行中的训练不算『上一次』，不会被复制」那条要按新语义重写。

---

## 6. 真机验收

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 开始训练 → 做两组 → 从最近任务里划掉 App（不点结束）→ 重开 | 主页显示「继续 今天 15:20 的训练 · 深蹲 等 N 个动作 · 已记 2 组」，点进去回到深蹲、第 3 组 |
| 2 | 结束训练 → 在总结页按系统返回键回主页 | 主页**没有**「继续」按钮 |
| 3 | 做一场 → 结束 → 保存 → 主页点「开始训练」 | 直接开新的，不弹询问；旧的那场不再出现 |
| 4 | 造一场未结束的（开始后划掉）→ 重开 → 点「开始新训练」 | 弹「上一场训练还没结束」；选「接着练」回到那场；再试一次选「结束它，开始新的」，旧的那场进历史，新的这场干净 |
| 5 | 看历史列表 | 进行中的训练不出现 |
| 6 | 深链 `gymtracker://session/<已结束的 id>` | 显示「这场训练已经结束」，不出现记录界面 |

---

## 7. 影响范围

| 文件 | 改动 |
|---|---|
| `src/store/activeSession.ts` | 主要改动：`startNew` 返回值与冲突分支、`endWorkout` 清内存并返回 id、`resume` 恢复 `currentIndex`、三处防御闸门 |
| `src/store/activeSession.test.ts` | 新不变量测试 + 一条既有用例按新语义重写 |
| `app/(tabs)/index.tsx` | 显示条件、按钮文案、冲突询问弹窗 |
| `app/session/[id].tsx` | 写保护、空态、防闪帧 |
| `app/session/summary/[id].tsx` | 「保存」→「完成」、兜底加锁 |
| `src/lib/format.ts`（新） | 从 `history.tsx` 抽出 `formatDate`，新增 `formatDateTime` |
| `app/(tabs)/history.tsx` | 改用 `src/lib/format.ts` |

---

## 8. 已知遗留

**必须重新打 APK。** 用户手机上那版是 2026-09-16 19:24 的代码（见 §1.3），本设计改的代码到不了他手上，除非跑一次 EAS 云构建。这正是 `docs/superpowers/plans/2026-09-16-m5-backup.md:228` 里那条未打勾的 TODO，本设计不重复它的步骤，但实施计划里要把「重新打包并安装」列为收尾项。

**旧包里的深蹲写死**：本设计不处理（代码里已经修了）。重新打包后，新训练沿用上一次**已结束**训练的动作组合；全新库里第一场是空训练，由「添加动作」引导。
