# 健身记录 App —— M1 + M2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出一个能在健身房真实使用的力量训练记录 App —— 从零搭建 Expo 项目，到「一组一记 + 组间休息正计时 + 实时落盘」全部可用。

**Architecture:** React Native (Expo) + TypeScript，四标签页骨架；SQLite 通过一层 `SqlExecutor` 接口访问，生产环境用 `expo-sqlite`，测试环境用 Node 内置的 `node:sqlite` 跑同一份 SQL；纯业务逻辑（指标计算、休息提示规则）放在 `src/domain/`，无 IO、全部单测。

**Tech Stack:** Expo SDK（最新稳定版）、TypeScript、expo-router、expo-sqlite、zustand、expo-keep-awake、expo-haptics、jest + babel-jest、node:sqlite（测试）

## Global Constraints

以下约束来自设计文档 `docs/superpowers/specs/2026-09-15-gym-tracker-design.md`，**每个任务都隐含包含本节**：

- **分层硬规则**：`app/` 与 `src/components/` **永远不直接 import `src/db/`** —— 不写 SQL、不碰 `expo-sqlite`、不碰 schema，所有数据访问只能经过 `src/repositories/`。SQL 执行器由 `src/repositories/database.tsx` 的 `useDatabase()` 下发。将来加云同步，改的是仓储层和这个 provider，界面一行不动。
- **每组完成即落盘**：`is_completed` 一置 1 就立刻写数据库，不等训练结束。这是可靠性要求，不是优化。
- **计时用时间戳**：休息时长一律用 `now − rest_started_at` 计算，**不得用 `setInterval` 累加计数**。App 被挂起十分钟后结果仍须准确。
- **容量负荷口径**：`总容量 = Σ(weight × reps)`，只累加 `is_completed = 1` 的组，单位 kg。文档与代码中一律称 **volume load / 容量负荷**，不叫 "volume"。
- **e1RM 口径**：`e1RM = (Epley + Brzycki + Lombardi) / 3`，其中 `Epley = w×(1+r/30)`、`Brzycki = w×36/(37−r)`、`Lombardi = w×r^0.1`。**仅当 `2 ≤ r ≤ 10` 时返回数值**；`r = 1` 返回 `w`；`r > 10` 返回 `null`。公式确定后不得更改。
- **休息提示只做展示**：只在训练总结页出现，不阻断操作，不做到点提醒，不做跨训练推断。**必须把次数数组原样显示**，必须标注「粗略参考」。
- **单位**：v1 只用 kg。数据库中所有重量都是 kg 的数值，不做单位字段。
- **语言**：所有面向用户的文案是简体中文。
- **测试必须带 `--runInBand`（环境强制）**：本项目所在的执行沙箱禁止子进程用管道捕获输出，而 jest 默认会 `fork` worker 来做 haste-map 扫描，结果是 `Error: spawn EPERM`。**所有 jest 调用都要带 `--runInBand`**（`package.json` 的 `test` 脚本里已经内置）。裸跑 jest 一定会失败，这不是代码问题。
- **读中文文件要用 read 工具**：在 PowerShell 里用 `Get-Content` 读本项目的中文源码会显示成乱码，那是控制台编码假象，文件本身是好的。判断文件内容一律以 read 工具的结果为准。
- **跑 Expo 命令必须关遥测**：Expo CLI 会往 `C:\Users\mobis\.expo` 写遥测数据，那是沙箱外的路径，会直接 `EPERM: operation not permitted, mkdir`。**所有 expo 命令前都要设 `EXPO_NO_TELEMETRY=1`**（PowerShell：`$env:EXPO_NO_TELEMETRY = '1'`）。
- **不要跑 `npx expo export`**：它最后一步要生成 Hermes 字节码，会 `spawn EPERM` 失败。这只是打包工具的沙箱限制，**不代表代码有问题**——Metro 打包本身是通的（可正常打出 1242 个模块的 bundle）。验证代码用 `tsc` + `jest`，验证运行用 `expo start` + 真机。

---

## 文件结构

```
app/                               expo-router 路由（文件即路由）
  _layout.tsx                      根布局：建库 + Stack
  (tabs)/
    _layout.tsx                    底部四标签
    index.tsx                      训练（默认页）
    history.tsx                    历史（M2 占位）
    progress.tsx                   进步（M2 占位）
    settings.tsx                   设置（M2 占位）
  session/
    [id].tsx                       核心记录界面 + 休息计时
    summary/[id].tsx               训练总结页
src/
  db/
    types.ts                       SqlExecutor 接口、数据库行类型
    schema.ts                      建表 SQL（纯字符串）
    migrations.ts                  版本化迁移列表
    expoSqlite.ts                  生产适配器（import expo-sqlite，不参与测试）
    __tests__/nodeExecutor.ts      测试适配器（node:sqlite）
  domain/
    types.ts                       领域模型类型
    metrics.ts                     容量负荷、e1RM
    metrics.test.ts
    restAdvice.ts                  组间休息提示规则
    restAdvice.test.ts
  repositories/
    exerciseRepo.ts
    exerciseRepo.test.ts
    sessionRepo.ts
    sessionRepo.test.ts
    setRepo.ts
    setRepo.test.ts
    seed.ts                        预置动作库数据
  store/
    activeSession.ts               Zustand：当前训练 + 休息计时
  lib/
    id.ts                          uuid 生成
    keepAwake.ts                   屏幕常亮
jest.config.js
babel.config.test.js
tsconfig.json
```

**为什么这么分**：`db/` 只管连接与 SQL 文本，`repositories/` 只管取数存数（接收 `SqlExecutor`，因此可在 Node 下测），`domain/` 是纯函数，`store/` 是界面状态机，`app/` 只是渲染。测试只覆盖前三层——UI 由用户在真机上验收。

---

### Task 1: 项目脚手架与四标签骨架

**Files:**
- Create: 整个 Expo 项目（通过 `create-expo-app`）
- Create: `app/_layout.tsx`、`app/(tabs)/_layout.tsx`、`app/(tabs)/index.tsx`、`app/(tabs)/history.tsx`、`app/(tabs)/progress.tsx`、`app/(tabs)/settings.tsx`
- Create: `tsconfig.json`、`jest.config.js`、`babel.config.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 无
- Produces: 可运行的四标签 App；`@/*` 路径别名指向 `src/*`；`npx jest --runInBand` 可运行

- [ ] **Step 1: 生成 Expo 脚手架**

仓库根目录已有 `docs/` 和 `.git`，`create-expo-app` 不接受非空目录，所以先建到子目录再搬上来。

**⚠️ 必须排除 `.git`**：`create-expo-app` 会在新目录里自己 `git init`。如果把它一起搬过来，就会用脚手架的空仓库覆盖掉本仓库，历史提交全部丢失。

```powershell
npx create-expo-app@latest expo-scaffold --template default --no-install
Get-ChildItem expo-scaffold -Force | Where-Object { $_.Name -notin @('.git', '.gitignore') } | Move-Item -Destination . -Force
Remove-Item -Recurse -Force expo-scaffold
npm install
```

搬完后**先确认历史还在**，再往下走：

```powershell
git log --oneline
```

Expected: 至少能看到 4 条提交（设计文档、两次规格修订、实施计划）。若这里报 `not a git repository` 或历史为空，**立刻停下并报告**，不要继续。

- [ ] **Step 2: 安装依赖**

```powershell
npx expo install expo-sqlite expo-keep-awake expo-haptics zustand
npm install --save-dev jest babel-jest @babel/preset-env @babel/preset-typescript @types/node @types/jest
```

- [ ] **Step 3: 配置 TypeScript**

覆盖 `tsconfig.json`：

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "types": ["node", "jest"],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
```

- [ ] **Step 4: 配置测试运行器**

`babel.config.test.js`（测试专用，与 App 的 `babel.config.js` 隔离，避免 React Native 预设污染 Node 环境）：

```js
module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    '@babel/preset-typescript',
  ],
};
```

`jest.config.js`：

```js
const path = require('path');

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'babel-jest',
      // 必须用绝对路径。<rootDir> 是 jest 自己的占位符，babel 不认识它，
      // 写成 '<rootDir>/babel.config.test.js' 会在第一个测试文件出现时才炸。
      { configFile: path.join(__dirname, 'babel.config.test.js') },
    ],
  },
};
```

在 `package.json` 的 `scripts` 中加入：

```json
"test": "jest",
"typecheck": "tsc --noEmit"
```

- [ ] **Step 5: 写四个标签页**

`app/(tabs)/_layout.tsx`：

```tsx
import { Tabs } from 'expo-router';

export default function TabLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: '训练' }} />
      <Tabs.Screen name="history" options={{ title: '历史' }} />
      <Tabs.Screen name="progress" options={{ title: '进步' }} />
      <Tabs.Screen name="settings" options={{ title: '设置' }} />
    </Tabs>
  );
}
```

`app/(tabs)/index.tsx`：

```tsx
import { View, Text, StyleSheet } from 'react-native';

export default function TrainTab() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>训练</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '600' },
});
```

`app/(tabs)/history.tsx` 与 `app/(tabs)/progress.tsx` 内容相同，只是标题文字不同：

```tsx
import { View, Text, StyleSheet } from 'react-native';

export default function HistoryTab() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>历史</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '600' },
});
```

`app/(tabs)/settings.tsx` 要多放一段静态说明 —— 设计文档 §8.1 要求把 ACSM 的一般参考区间展示出来，**并且明确写清这只作参考**，不参与任何自动计算：

```tsx
import { ScrollView, StyleSheet, Text, View } from 'react-native';

export default function SettingsTab() {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>设置</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>组间休息的一般参考</Text>
        <Text style={styles.line}>· 多关节动作（深蹲、卧推、硬拉等）：2 – 3 分钟</Text>
        <Text style={styles.line}>· 单关节动作（弯举、侧平举等）：1 – 2 分钟</Text>
        <Text style={styles.note}>
          以上是 ACSM 立场声明给出的一般区间，仅供参考。
          本 App 不会用它做任何自动计算 —— 训练后只比较你自己这次的次数变化。
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 16 },
  title: { fontSize: 24, fontWeight: '700' },
  card: { backgroundColor: '#f4f5f7', borderRadius: 12, padding: 16, gap: 6 },
  cardTitle: { fontSize: 15, fontWeight: '700', marginBottom: 4 },
  line: { fontSize: 14, color: '#4b5058' },
  note: { fontSize: 12, color: '#8a8f98', marginTop: 8, lineHeight: 18 },
});
```

把 `app/_layout.tsx` 覆盖为：

```tsx
import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
```

- [ ] **Step 6: 补全 .gitignore**

确保 `.gitignore` 至少包含以下条目（模板生成的条目保留，不要删）：

```
node_modules/
.expo/
dist/
web-build/
.superpowers/
*.log
.DS_Store
```

- [ ] **Step 7: 验证类型检查与测试命令可跑**

```powershell
npx tsc --noEmit
npx jest --runInBand
```

Expected: `tsc` 无输出（无错误）；`jest` 输出 `No tests found`，退出码 1。这是正常的——测试要到 Task 2 才存在。

- [ ] **Step 8: 在真机上验证四个标签**

```powershell
npx expo start
```

用手机上的 Expo Go 扫码。Expected: App 打开，底部出现「训练 / 历史 / 进步 / 设置」四个标签，点击能互相切换；「设置」页显示组间休息的参考区间与「仅供参考」说明。

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat: Expo 项目脚手架与四标签骨架"
```

---

### Task 2: 指标计算（容量负荷与 e1RM）

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/metrics.ts`
- Test: `src/domain/metrics.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type SetLike = { weight: number; reps: number; isCompleted: boolean }`
  - `totalVolumeLoad(sets: SetLike[]): number`
  - `estimateOneRepMax(weight: number, reps: number): number | null`

- [ ] **Step 1: 写领域类型**

`src/domain/types.ts`：

```ts
export interface Exercise {
  id: string;
  name: string;
  muscleGroup: string | null;
  equipment: string | null;
  isCustom: boolean;
  isArchived: boolean;
  createdAt: number;
}

export interface WorkoutSession {
  id: string;
  name: string | null;
  startedAt: number;
  finishedAt: number | null;
  note: string | null;
}

export interface SessionExercise {
  id: string;
  sessionId: string;
  exerciseId: string;
  position: number;
  note: string | null;
}

export interface SetEntry {
  id: string;
  sessionExerciseId: string;
  position: number;
  weight: number;
  reps: number;
  isCompleted: boolean;
  /** 本组做完后休息了多久（秒）。NULL 表示还没结束那次休息，或这是最后一组 */
  restSeconds: number | null;
  /** 休息开始的时间戳。非 NULL 表示正在休息中 */
  restStartedAt: number | null;
  completedAt: number | null;
}

export interface SetLike {
  weight: number;
  reps: number;
  isCompleted: boolean;
}
```

- [ ] **Step 2: 写失败的测试**

`src/domain/metrics.test.ts`：

```ts
import { totalVolumeLoad, estimateOneRepMax } from './metrics';

describe('totalVolumeLoad', () => {
  it('累加所有已完成组的 重量 × 次数', () => {
    const sets = [
      { weight: 100, reps: 5, isCompleted: true },
      { weight: 100, reps: 5, isCompleted: true },
      { weight: 100, reps: 3, isCompleted: true },
    ];
    expect(totalVolumeLoad(sets)).toBe(1300);
  });

  it('跳过未完成的组', () => {
    const sets = [
      { weight: 100, reps: 5, isCompleted: true },
      { weight: 100, reps: 5, isCompleted: false },
    ];
    expect(totalVolumeLoad(sets)).toBe(500);
  });

  it('空数组返回 0', () => {
    expect(totalVolumeLoad([])).toBe(0);
  });

  it('支持小数重量', () => {
    const sets = [{ weight: 2.5, reps: 10, isCompleted: true }];
    expect(totalVolumeLoad(sets)).toBe(25);
  });
});

describe('estimateOneRepMax', () => {
  it('次数为 1 时直接返回原重量', () => {
    expect(estimateOneRepMax(140, 1)).toBe(140);
  });

  it('次数大于 10 时返回 null（外推严重失真，必须不显示）', () => {
    expect(estimateOneRepMax(60, 11)).toBeNull();
    expect(estimateOneRepMax(60, 20)).toBeNull();
  });

  it('次数为 10 时仍然计算（上边界内）', () => {
    expect(estimateOneRepMax(100, 10)).not.toBeNull();
  });

  it('次数小于 1 时返回 null', () => {
    expect(estimateOneRepMax(100, 0)).toBeNull();
  });

  it('100kg × 5 次的结果在三公式平均的预期范围内', () => {
    // Epley:    100 * (1 + 5/30)      = 116.6667
    // Brzycki:  100 * 36 / 32         = 112.5
    // Lombardi: 100 * 5^0.1           = 117.4614
    // 平均                           = 115.5427
    const result = estimateOneRepMax(100, 5);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(115.54, 1);
  });

  it('e1RM 必定不小于原重量', () => {
    for (let reps = 2; reps <= 10; reps++) {
      const result = estimateOneRepMax(100, reps);
      expect(result!).toBeGreaterThanOrEqual(100);
    }
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

```powershell
npx jest --runInBand src/domain/metrics.test.ts
```

Expected: FAIL —— 找不到模块 `./metrics`。

- [ ] **Step 4: 写实现**

`src/domain/metrics.ts`：

```ts
import type { SetLike } from './types';

/**
 * 容量负荷（volume load）= Σ(重量 × 次数)，只累加已完成的组。
 *
 * 注意：文献中 "volume" 一词口径不统一（有的指总次数，有的指组数×次数）。
 * 本 App 一律采用含重量的 volume load 口径，命名上也必须叫 volumeLoad 而不是 volume。
 */
export function totalVolumeLoad(sets: SetLike[]): number {
  return sets.reduce(
    (sum, s) => (s.isCompleted ? sum + s.weight * s.reps : sum),
    0,
  );
}

/**
 * 估算 1RM（e1RM）。
 *
 * 采用三种经典公式的算术平均，以降低单一公式的偏差——同一组数据这三个公式
 * 会给出不同结果，没有任何一个被公认最准。
 *
 * 适用范围：仅当 2 <= reps <= 10 时有效。次数 > 10 时外推严重失真，返回 null，
 * 调用方必须不显示该值。reps === 1 时直接返回实测重量。
 *
 * 界面必须标注「估算 · 仅供参考」。公式一旦确定不得更改，否则进步曲线会断层。
 */
export function estimateOneRepMax(weight: number, reps: number): number | null {
  if (reps < 1) return null;
  if (reps === 1) return weight;
  if (reps > 10) return null;

  const epley = weight * (1 + reps / 30);
  const brzycki = (weight * 36) / (37 - reps);
  const lombardi = weight * Math.pow(reps, 0.1);

  return (epley + brzycki + lombardi) / 3;
}
```

- [ ] **Step 5: 运行测试，确认通过**

```powershell
npx jest --runInBand src/domain/metrics.test.ts
```

Expected: PASS，10 个测试全绿。

- [ ] **Step 6: 提交**

```powershell
git add src/domain
git commit -m "feat(domain): 容量负荷与 e1RM 估算"
```

---

### Task 3: 组间休息提示规则

**Files:**
- Create: `src/domain/restAdvice.ts`
- Test: `src/domain/restAdvice.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type RestFeedbackKind = 'positive' | 'add_weight' | 'extend_15' | 'extend_30' | 'extend_30_check_weight'`
  - `interface RestFeedback { kind: RestFeedbackKind; reps: number[]; drop: number; avgRest: number | null; message: string }`
  - `buildRestFeedback(reps: number[], rests: (number | null)[]): RestFeedback | null`

**设计约束（来自文档 §8）**：只看本次训练内的次数数组，不跨训练推断；组数 < 3 时返回 `null`（明确沉默）；文案必须带上原始数字。

- [ ] **Step 1: 写失败的测试**

`src/domain/restAdvice.test.ts`：

```ts
import { buildRestFeedback } from './restAdvice';

describe('buildRestFeedback', () => {
  it('少于 3 组时保持沉默', () => {
    expect(buildRestFeedback([5, 5], [90, 90])).toBeNull();
    expect(buildRestFeedback([5], [])).toBeNull();
    expect(buildRestFeedback([], [])).toBeNull();
  });

  it('次数没掉且休息正常时给正反馈', () => {
    const r = buildRestFeedback([5, 5, 5, 5], [90, 90, 90]);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('positive');
    expect(r!.drop).toBe(0);
    expect(r!.message).toContain('稳住');
  });

  it('末组超过首组（负 drop）同样算站住了', () => {
    const r = buildRestFeedback([3, 4, 5], [60, 60]);
    expect(r!.kind).toBe('positive');
    expect(r!.drop).toBe(-2);
  });

  it('没掉次数但平均休息超过 180 秒时建议加重量', () => {
    const r = buildRestFeedback([5, 5, 5], [200, 210, 190]);
    expect(r!.kind).toBe('add_weight');
    expect(r!.message).toContain('加重量');
    expect(r!.avgRest).toBe(200);
  });

  it('平均休息正好 180 秒时不算超长', () => {
    const r = buildRestFeedback([5, 5, 5], [180, 180, 180]);
    expect(r!.kind).toBe('positive');
  });

  it('休息数据全为空时按无休息数据处理，仍可给正反馈', () => {
    const r = buildRestFeedback([5, 5, 5], [null, null, null]);
    expect(r!.kind).toBe('positive');
    expect(r!.avgRest).toBeNull();
  });

  it('掉 1 次建议多歇 15 秒', () => {
    const r = buildRestFeedback([5, 5, 5, 4], [90, 90, 90]);
    expect(r!.kind).toBe('extend_15');
    expect(r!.drop).toBe(1);
    expect(r!.message).toContain('15 秒');
  });

  it('掉 2 次建议多歇 30 秒', () => {
    const r = buildRestFeedback([5, 5, 5, 3], [90, 90, 90]);
    expect(r!.kind).toBe('extend_30');
    expect(r!.drop).toBe(2);
    expect(r!.message).toContain('30 秒');
  });

  it('掉 3 次以上除建议延长外，还提示可能是重量偏大', () => {
    const r = buildRestFeedback([5, 5, 5, 2], [90, 90, 90]);
    expect(r!.kind).toBe('extend_30_check_weight');
    expect(r!.drop).toBe(3);
    expect(r!.message).toContain('重量偏大');
  });

  it('必须原样带回次数数组，供界面展示', () => {
    const r = buildRestFeedback([5, 5, 5, 3, 3], [90, 90, 90, 90]);
    expect(r!.reps).toEqual([5, 5, 5, 3, 3]);
  });

  it('只有 3 组且掉 2 次时也照常判断（3 组是可判断的下限）', () => {
    const r = buildRestFeedback([10, 8, 8], [60, 60]);
    expect(r!.kind).toBe('extend_30');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```powershell
npx jest --runInBand src/domain/restAdvice.test.ts
```

Expected: FAIL —— 找不到模块 `./restAdvice`。

- [ ] **Step 3: 写实现**

`src/domain/restAdvice.ts`：

```ts
export type RestFeedbackKind =
  | 'positive'
  | 'add_weight'
  | 'extend_15'
  | 'extend_30'
  | 'extend_30_check_weight';

export interface RestFeedback {
  kind: RestFeedbackKind;
  /** 原始次数数组。界面必须原样展示，让用户能自己核对 */
  reps: number[];
  /** 首组次数 − 末组次数 */
  drop: number;
  /** 平均组后休息秒数；没有休息数据时为 null */
  avgRest: number | null;
  message: string;
}

/** 平均休息超过这个秒数，且次数没掉，就认为「还有余力」 */
const LONG_REST_THRESHOLD_SECONDS = 180;

/** 少于这个组数就不作判断 */
const MIN_SETS = 3;

function averageRest(rests: (number | null)[]): number | null {
  const values = rests.filter((r): r is number => r !== null && r !== undefined);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function formatReps(reps: number[]): string {
  return reps.join(' / ');
}

/**
 * 生成训练后的组间休息提示。
 *
 * 这是**粗略参考**，不是科学结论：只比较本次训练内首组与末组的次数差异，
 * 不跨训练推断、不建统计模型。该领域文献本身对最优休息时长没有共识，
 * 且同一个人不同训练日的反应差异明显。
 *
 * 组数少于 3 时返回 null —— 数据不足时明确沉默，不硬给建议。
 */
export function buildRestFeedback(
  reps: number[],
  rests: (number | null)[],
): RestFeedback | null {
  if (reps.length < MIN_SETS) return null;

  const first = reps[0];
  const last = reps[reps.length - 1];
  const drop = first - last;
  const avgRest = averageRest(rests);
  const list = formatReps(reps);
  const restText = avgRest === null ? null : Math.round(avgRest);

  if (drop <= 0) {
    if (restText !== null && restText > LONG_REST_THRESHOLD_SECONDS) {
      const minutes = Math.floor(restText / 60);
      const seconds = restText % 60;
      return {
        kind: 'add_weight',
        reps,
        drop,
        avgRest,
        message: `${list} 全程稳定，平均歇了 ${minutes} 分 ${seconds} 秒 —— 还有余力，可以考虑加重量`,
      };
    }
    return {
      kind: 'positive',
      reps,
      drop,
      avgRest,
      message: `${list} 全程稳住了，节奏合适`,
    };
  }

  if (drop === 1) {
    return {
      kind: 'extend_15',
      reps,
      drop,
      avgRest,
      message: `末组 ${first} → ${last}，下次这个动作可以多歇 15 秒`,
    };
  }

  if (drop === 2) {
    return {
      kind: 'extend_30',
      reps,
      drop,
      avgRest,
      message: `末组 ${first} → ${last}，下次可以多歇 30 秒`,
    };
  }

  return {
    kind: 'extend_30_check_weight',
    reps,
    drop,
    avgRest,
    message: `末组 ${first} → ${last}，多歇 30 秒试试；如果还是掉，可能是重量偏大`,
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

```powershell
npx jest --runInBand src/domain/restAdvice.test.ts
```

Expected: PASS，11 个测试全绿。

- [ ] **Step 5: 提交**

```powershell
git add src/domain
git commit -m "feat(domain): 组间休息提示规则"
```

---

### Task 4: 数据库 schema、迁移与执行器

**Files:**
- Create: `src/db/types.ts`
- Create: `src/db/schema.ts`
- Create: `src/db/migrations.ts`
- Create: `src/db/expoSqlite.ts`
- Create: `src/db/__tests__/nodeExecutor.ts`
- Create: `src/db/migrations.test.ts`
- Create: `src/lib/id.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface SqlExecutor { run(sql: string, params?: unknown[]): Promise<void>; all<T>(sql: string, params?: unknown[]): Promise<T[]>; first<T>(sql: string, params?: unknown[]): Promise<T | null> }`
  - `const SCHEMA_VERSION: number`
  - `const MIGRATIONS: { version: number; statements: string[] }[]`
  - `migrate(exec: SqlExecutor): Promise<void>`
  - `createExpoExecutor(db: SQLiteDatabase): SqlExecutor`
  - `newId(): string`

**背景**：`expo-sqlite` 无法在 Node 下运行，所以仓储层不直接依赖它，而是接收一个 `SqlExecutor`。生产环境用 `createExpoExecutor`，测试用 `createNodeExecutor`（Node 24 内置的 `node:sqlite`）。两边跑的是**同一份 SQL 字符串**，因此 SQL 本身是被真实 SQLite 验证过的。

- [ ] **Step 1: 写 SQL 执行器接口与 schema**

`src/db/types.ts`：

```ts
export interface SqlExecutor {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
}

export const SCHEMA_VERSION = 1;
```

`src/db/schema.ts`：

```ts
/**
 * 建表 SQL。测试（node:sqlite）与生产（expo-sqlite）共用同一份字符串，
 * 因此这里任何语法错误都会在单元测试里立刻暴露。
 */
export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS exercise (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  muscle_group  TEXT,
  equipment     TEXT,
  is_custom     INTEGER NOT NULL DEFAULT 0,
  is_archived   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS session_exercise (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercise(id),
  position    INTEGER NOT NULL,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS set_entry (
  id                  TEXT PRIMARY KEY,
  session_exercise_id TEXT NOT NULL REFERENCES session_exercise(id) ON DELETE CASCADE,
  position            INTEGER NOT NULL,
  weight              REAL NOT NULL,
  reps                INTEGER NOT NULL,
  is_completed        INTEGER NOT NULL DEFAULT 0,
  rest_seconds        INTEGER,
  rest_started_at     INTEGER,
  completed_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_session_finished ON session(finished_at);
CREATE INDEX IF NOT EXISTS idx_session_exercise_session ON session_exercise(session_id);
CREATE INDEX IF NOT EXISTS idx_set_entry_session_exercise ON set_entry(session_exercise_id);
`;

export const CREATE_META_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
```

- [ ] **Step 2: 写迁移**

`src/db/migrations.ts`：

```ts
import type { SqlExecutor } from './types';
import { CREATE_META_SQL, CREATE_TABLES_SQL } from './schema';

export interface Migration {
  version: number;
  statements: string[];
}

/**
 * 版本化迁移。新增 schema 变更时追加一项，不要修改已发布的项。
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [CREATE_META_SQL, CREATE_TABLES_SQL],
  },
];

export async function getSchemaVersion(exec: SqlExecutor): Promise<number> {
  const row = await exec.first<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = 'schema_version'",
  );
  return row ? Number(row.value) : 0;
}

/**
 * 依次执行尚未应用的迁移，完成后写入新的版本号。
 * 已经是最新版本时不做任何事。
 */
export async function migrate(exec: SqlExecutor): Promise<void> {
  // app_meta 必须先存在，否则读不到版本号
  await exec.run(CREATE_META_SQL);

  const current = await getSchemaVersion(exec);
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    for (const statement of migration.statements) {
      await exec.run(statement);
    }
    await exec.run(
      `INSERT INTO app_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(migration.version)],
    );
  }
}
```

- [ ] **Step 3: 写测试适配器（node:sqlite）**

`src/db/__tests__/nodeExecutor.ts`：

```ts
import { DatabaseSync } from 'node:sqlite';
import type { SqlExecutor } from '../types';

/**
 * 用 Node 24 内置的 node:sqlite 在内存里跑一份真实 SQLite。
 * 仅供测试使用——生产环境走 src/db/expoSqlite.ts。
 */
export function createNodeExecutor(): { exec: SqlExecutor; raw: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');

  const exec: SqlExecutor = {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async first<T>(sql: string, params: unknown[] = []) {
      const row = db.prepare(sql).get(...(params as never[]));
      return (row ?? null) as T | null;
    },
  };

  return { exec, raw: db };
}

/** 建好库并跑完迁移，返回可直接使用的执行器 */
export async function createMigratedExecutor(): Promise<SqlExecutor> {
  const { migrate } = await import('../migrations');
  const { exec } = createNodeExecutor();
  await migrate(exec);
  return exec;
}
```

- [ ] **Step 4: 写失败的测试**

`src/db/migrations.test.ts`：

```ts
import { createNodeExecutor } from './__tests__/nodeExecutor';
import { migrate, getSchemaVersion, MIGRATIONS } from './migrations';

async function tableNames(exec: ReturnType<typeof createNodeExecutor>['exec']) {
  const rows = await exec.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return rows.map((r) => r.name);
}

describe('migrate', () => {
  it('建出全部业务表', async () => {
    const { exec } = createNodeExecutor();
    await migrate(exec);
    const names = await tableNames(exec);
    expect(names).toEqual(
      expect.arrayContaining([
        'app_meta',
        'exercise',
        'session',
        'session_exercise',
        'set_entry',
      ]),
    );
  });

  it('迁移后版本号等于最大迁移版本', async () => {
    const { exec } = createNodeExecutor();
    await migrate(exec);
    const maxVersion = Math.max(...MIGRATIONS.map((m) => m.version));
    expect(await getSchemaVersion(exec)).toBe(maxVersion);
  });

  it('重复调用是幂等的，不报错', async () => {
    const { exec } = createNodeExecutor();
    await migrate(exec);
    await migrate(exec);
    await migrate(exec);
    expect(await getSchemaVersion(exec)).toBe(
      Math.max(...MIGRATIONS.map((m) => m.version)),
    );
  });

  it('未迁移时版本号为 0', async () => {
    const { exec } = createNodeExecutor();
    expect(await getSchemaVersion(exec)).toBe(0);
  });

  it('外键约束已开启：插入不存在的 session 会被拒绝', async () => {
    const { exec } = createNodeExecutor();
    await migrate(exec);
    await expect(
      exec.run(
        `INSERT INTO session_exercise (id, session_id, exercise_id, position)
         VALUES ('se1', 'nope', 'nope2', 0)`,
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 5: 运行测试，确认失败**

```powershell
npx jest --runInBand src/db/migrations.test.ts
```

Expected: FAIL —— 找不到模块 `./migrations`。

- [ ] **Step 6: 运行测试，确认通过**

创建好 Step 2、Step 3 的文件后：

```powershell
npx jest --runInBand src/db/migrations.test.ts
```

Expected: PASS，5 个测试全绿。

- [ ] **Step 7: 写 id 生成器**

`src/lib/id.ts`：

```ts
/**
 * 生成一个够用的唯一 id。
 * 不引入 uuid 依赖：时间戳 + 随机后缀在单机 App 内已足够，且天然按时间有序。
 */
export function newId(): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${time}-${random}`;
}
```

- [ ] **Step 8: 写生产适配器**

`src/db/expoSqlite.ts`（**不参与单元测试**，因为 expo-sqlite 无法在 Node 下运行）：

```ts
import type { SQLiteDatabase } from 'expo-sqlite';
import type { SqlExecutor } from './types';

export function createExpoExecutor(db: SQLiteDatabase): SqlExecutor {
  return {
    async run(sql, params = []) {
      await db.runAsync(sql, params as never[]);
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.getAllAsync<T>(sql, params as never[]);
    },
    async first<T>(sql: string, params: unknown[] = []) {
      const row = await db.getFirstAsync<T>(sql, params as never[]);
      return row ?? null;
    },
  };
}
```

- [ ] **Step 9: 提交**

```powershell
git add src
git commit -m "feat(db): schema、版本化迁移与可测试的 SQL 执行器"
```

---

### Task 5: 动作库仓储与预置数据

**Files:**
- Create: `src/repositories/seed.ts`
- Create: `src/repositories/exerciseRepo.ts`
- Test: `src/repositories/exerciseRepo.test.ts`

**Interfaces:**
- Consumes: `SqlExecutor`（Task 4）、`newId()`（Task 4）、`Exercise`（Task 2）
- Produces:
  - `interface SeedExercise { name: string; muscleGroup: string; equipment: string }`
  - `const SEED_EXERCISES: SeedExercise[]`
  - `seedExercisesIfEmpty(exec: SqlExecutor): Promise<void>`
  - `listExercises(exec: SqlExecutor): Promise<Exercise[]>`
  - `getExercise(exec: SqlExecutor, id: string): Promise<Exercise | null>`
  - `createCustomExercise(exec: SqlExecutor, name: string, muscleGroup: string | null, equipment: string | null): Promise<Exercise>`

- [ ] **Step 1: 写预置动作库**

`src/repositories/seed.ts` 的 `SEED_EXERCISES` 至少包含下列动作（`muscleGroup` 取值限定为：胸 / 背 / 腿 / 肩 / 手臂 / 核心；`equipment` 取值限定为：杠铃 / 哑铃 / 器械 / 自重 / 绳索）：

```ts
export interface SeedExercise {
  name: string;
  muscleGroup: string;
  equipment: string;
}

export const SEED_EXERCISES: SeedExercise[] = [
  // 腿
  { name: '深蹲', muscleGroup: '腿', equipment: '杠铃' },
  { name: '前蹲', muscleGroup: '腿', equipment: '杠铃' },
  { name: '硬拉', muscleGroup: '腿', equipment: '杠铃' },
  { name: '罗马尼亚硬拉', muscleGroup: '腿', equipment: '杠铃' },
  { name: '腿举', muscleGroup: '腿', equipment: '器械' },
  { name: '腿屈伸', muscleGroup: '腿', equipment: '器械' },
  { name: '腿弯举', muscleGroup: '腿', equipment: '器械' },
  { name: '保加利亚分腿蹲', muscleGroup: '腿', equipment: '哑铃' },
  { name: '箭步蹲', muscleGroup: '腿', equipment: '哑铃' },
  { name: '站姿提踵', muscleGroup: '腿', equipment: '器械' },
  { name: '坐姿提踵', muscleGroup: '腿', equipment: '器械' },
  { name: '臀推', muscleGroup: '腿', equipment: '杠铃' },

  // 胸
  { name: '卧推', muscleGroup: '胸', equipment: '杠铃' },
  { name: '上斜卧推', muscleGroup: '胸', equipment: '杠铃' },
  { name: '下斜卧推', muscleGroup: '胸', equipment: '杠铃' },
  { name: '哑铃卧推', muscleGroup: '胸', equipment: '哑铃' },
  { name: '哑铃飞鸟', muscleGroup: '胸', equipment: '哑铃' },
  { name: '绳索夹胸', muscleGroup: '胸', equipment: '绳索' },
  { name: '双杠臂屈伸', muscleGroup: '胸', equipment: '自重' },
  { name: '俯卧撑', muscleGroup: '胸', equipment: '自重' },
  { name: '器械推胸', muscleGroup: '胸', equipment: '器械' },

  // 背
  { name: '引体向上', muscleGroup: '背', equipment: '自重' },
  { name: '高位下拉', muscleGroup: '背', equipment: '器械' },
  { name: '杠铃划船', muscleGroup: '背', equipment: '杠铃' },
  { name: '哑铃单臂划船', muscleGroup: '背', equipment: '哑铃' },
  { name: '坐姿绳索划船', muscleGroup: '背', equipment: '绳索' },
  { name: 'T 杠划船', muscleGroup: '背', equipment: '杠铃' },
  { name: '直臂下压', muscleGroup: '背', equipment: '绳索' },
  { name: '面拉', muscleGroup: '背', equipment: '绳索' },
  { name: '山羊挺身', muscleGroup: '背', equipment: '自重' },

  // 肩
  { name: '站姿推举', muscleGroup: '肩', equipment: '杠铃' },
  { name: '坐姿哑铃推举', muscleGroup: '肩', equipment: '哑铃' },
  { name: '侧平举', muscleGroup: '肩', equipment: '哑铃' },
  { name: '前平举', muscleGroup: '肩', equipment: '哑铃' },
  { name: '俯身飞鸟', muscleGroup: '肩', equipment: '哑铃' },
  { name: '反向蝴蝶机', muscleGroup: '肩', equipment: '器械' },
  { name: '耸肩', muscleGroup: '肩', equipment: '杠铃' },

  // 手臂
  { name: '杠铃弯举', muscleGroup: '手臂', equipment: '杠铃' },
  { name: '哑铃弯举', muscleGroup: '手臂', equipment: '哑铃' },
  { name: '锤式弯举', muscleGroup: '手臂', equipment: '哑铃' },
  { name: '牧师凳弯举', muscleGroup: '手臂', equipment: '器械' },
  { name: '绳索下压', muscleGroup: '手臂', equipment: '绳索' },
  { name: '仰卧臂屈伸', muscleGroup: '手臂', equipment: '杠铃' },
  { name: '过顶臂屈伸', muscleGroup: '手臂', equipment: '哑铃' },
  { name: '窄距卧推', muscleGroup: '手臂', equipment: '杠铃' },
  { name: '腕弯举', muscleGroup: '手臂', equipment: '哑铃' },

  // 核心
  { name: '卷腹', muscleGroup: '核心', equipment: '自重' },
  { name: '悬垂举腿', muscleGroup: '核心', equipment: '自重' },
  { name: '平板支撑', muscleGroup: '核心', equipment: '自重' },
  { name: '俄罗斯转体', muscleGroup: '核心', equipment: '哑铃' },
  { name: '绳索卷腹', muscleGroup: '核心', equipment: '绳索' },
  { name: '健腹轮', muscleGroup: '核心', equipment: '自重' },
];
```

- [ ] **Step 2: 写失败的测试**

`src/repositories/exerciseRepo.test.ts`：

```ts
import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import {
  createCustomExercise,
  getExercise,
  listExercises,
  seedExercisesIfEmpty,
} from './exerciseRepo';
import { SEED_EXERCISES } from './seed';

describe('exerciseRepo', () => {
  it('种子数据可以写入，且包含预置动作', async () => {
    const exec = await createMigratedExecutor();
    await seedExercisesIfEmpty(exec);
    const all = await listExercises(exec);
    expect(all.length).toBe(SEED_EXERCISES.length);
    expect(all.map((e) => e.name)).toContain('深蹲');
  });

  it('重复播种不会重复插入', async () => {
    const exec = await createMigratedExecutor();
    await seedExercisesIfEmpty(exec);
    await seedExercisesIfEmpty(exec);
    const all = await listExercises(exec);
    expect(all.length).toBe(SEED_EXERCISES.length);
  });

  it('库中已有自定义动作时也不会重复播种', async () => {
    const exec = await createMigratedExecutor();
    await createCustomExercise(exec, '我的动作', '胸', '哑铃');
    await seedExercisesIfEmpty(exec);
    const all = await listExercises(exec);
    expect(all.length).toBe(1);
  });

  it('isCustom 与 isArchived 正确映射为布尔值', async () => {
    const exec = await createMigratedExecutor();
    const created = await createCustomExercise(exec, '自定义动作', '背', '器械');
    expect(created.isCustom).toBe(true);
    expect(created.isArchived).toBe(false);
  });

  it('getExercise 能取回刚创建的动作', async () => {
    const exec = await createMigratedExecutor();
    const created = await createCustomExercise(exec, '自定义动作', '背', '器械');
    const found = await getExercise(exec, created.id);
    expect(found?.name).toBe('自定义动作');
    expect(found?.muscleGroup).toBe('背');
  });

  it('getExercise 对不存在的 id 返回 null', async () => {
    const exec = await createMigratedExecutor();
    expect(await getExercise(exec, 'nope')).toBeNull();
  });

  it('列表按肌群与名称稳定排序', async () => {
    const exec = await createMigratedExecutor();
    await seedExercisesIfEmpty(exec);
    const all = await listExercises(exec);
    const legs = all.filter((e) => e.muscleGroup === '腿').map((e) => e.name);
    expect(legs).toEqual([...legs].sort((a, b) => a.localeCompare(b, 'zh')));
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

```powershell
npx jest --runInBand src/repositories/exerciseRepo.test.ts
```

Expected: FAIL —— 找不到模块 `./exerciseRepo`。

- [ ] **Step 4: 写实现**

`src/repositories/exerciseRepo.ts`：

```ts
import type { SqlExecutor } from '../db/types';
import type { Exercise } from '../domain/types';
import { newId } from '../lib/id';
import { SEED_EXERCISES } from './seed';

interface ExerciseRow {
  id: string;
  name: string;
  muscle_group: string | null;
  equipment: string | null;
  is_custom: number;
  is_archived: number;
  created_at: number;
}

function toExercise(row: ExerciseRow): Exercise {
  return {
    id: row.id,
    name: row.name,
    muscleGroup: row.muscle_group,
    equipment: row.equipment,
    isCustom: row.is_custom === 1,
    isArchived: row.is_archived === 1,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = `
  id, name, muscle_group, equipment, is_custom, is_archived, created_at
`;

const ORDER_BY = `
  ORDER BY
    CASE muscle_group
      WHEN '胸' THEN 1 WHEN '背' THEN 2 WHEN '腿' THEN 3
      WHEN '肩' THEN 4 WHEN '手臂' THEN 5 WHEN '核心' THEN 6
      ELSE 7
    END,
    name COLLATE NOCASE
`;

export async function listExercises(exec: SqlExecutor): Promise<Exercise[]> {
  const rows = await exec.all<ExerciseRow>(
    `SELECT ${SELECT_COLUMNS} FROM exercise WHERE is_archived = 0 ${ORDER_BY}`,
  );
  return rows.map(toExercise);
}

export async function getExercise(
  exec: SqlExecutor,
  id: string,
): Promise<Exercise | null> {
  const row = await exec.first<ExerciseRow>(
    `SELECT ${SELECT_COLUMNS} FROM exercise WHERE id = ?`,
    [id],
  );
  return row ? toExercise(row) : null;
}

export async function createCustomExercise(
  exec: SqlExecutor,
  name: string,
  muscleGroup: string | null,
  equipment: string | null,
): Promise<Exercise> {
  const exercise: Exercise = {
    id: newId(),
    name,
    muscleGroup,
    equipment,
    isCustom: true,
    isArchived: false,
    createdAt: Date.now(),
  };

  await exec.run(
    `INSERT INTO exercise (id, name, muscle_group, equipment, is_custom, is_archived, created_at)
     VALUES (?, ?, ?, ?, 1, 0, ?)`,
    [
      exercise.id,
      exercise.name,
      exercise.muscleGroup,
      exercise.equipment,
      exercise.createdAt,
    ],
  );

  return exercise;
}

/**
 * 只在动作表为空时写入预置动作。
 * 判断依据是「表里一个动作都没有」，而不是「表里没有预置动作」——
 * 用户如果自己先建了动作，就不该再塞一堆预置动作进去。
 */
export async function seedExercisesIfEmpty(exec: SqlExecutor): Promise<void> {
  const row = await exec.first<{ count: number }>(
    'SELECT COUNT(*) AS count FROM exercise',
  );
  if (row && row.count > 0) return;

  const now = Date.now();
  for (const item of SEED_EXERCISES) {
    await exec.run(
      `INSERT INTO exercise (id, name, muscle_group, equipment, is_custom, is_archived, created_at)
       VALUES (?, ?, ?, ?, 0, 0, ?)`,
      [newId(), item.name, item.muscleGroup, item.equipment, now],
    );
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

```powershell
npx jest --runInBand src/repositories/exerciseRepo.test.ts
```

Expected: PASS，7 个测试全绿。

- [ ] **Step 6: 提交**

```powershell
git add src
git commit -m "feat(repo): 动作库仓储与 53 个预置动作"
```

---

### Task 6: 训练与组的仓储（含崩溃恢复）

**Files:**
- Create: `src/repositories/sessionRepo.ts`
- Create: `src/repositories/setRepo.ts`
- Test: `src/repositories/sessionRepo.test.ts`
- Test: `src/repositories/setRepo.test.ts`

**Interfaces:**
- Consumes: `SqlExecutor`（Task 4）、`newId()`（Task 4）、`WorkoutSession` / `SessionExercise` / `SetEntry`（Task 2）
- Produces:
  - `createSession(exec, name: string | null): Promise<WorkoutSession>`
  - `getSession(exec, id): Promise<WorkoutSession | null>`
  - `getActiveSession(exec): Promise<WorkoutSession | null>`
  - `finishSession(exec, id: string, finishedAt: number): Promise<void>`
  - `listSessions(exec, limit: number): Promise<WorkoutSession[]>`
  - `addExerciseToSession(exec, sessionId: string, exerciseId: string): Promise<SessionExercise>`
  - `listSessionExercises(exec, sessionId: string): Promise<SessionExercise[]>`
  - `addSet(exec, sessionExerciseId: string, weight: number, reps: number): Promise<SetEntry>`
  - `listSets(exec, sessionExerciseId: string): Promise<SetEntry[]>`
  - `completeSet(exec, setId: string, completedAt: number): Promise<void>`
  - `startRest(exec, setId: string, at: number): Promise<void>`
  - `endRest(exec, setId: string, at: number): Promise<void>`
  - `getLastPerformance(exec, exerciseId: string, beforeSessionId: string): Promise<SetEntry[]>`

- [ ] **Step 1: 写失败的三八测试（sessionRepo）**

`src/repositories/sessionRepo.test.ts`：

```ts
import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import {
  addExerciseToSession,
  createSession,
  finishSession,
  getActiveSession,
  getSession,
  listSessionExercises,
  listSessions,
} from './sessionRepo';
import { createCustomExercise } from './exerciseRepo';

describe('sessionRepo', () => {
  it('新建的训练是进行中状态', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日');
    expect(s.name).toBe('腿部日');
    expect(s.finishedAt).toBeNull();
    expect(s.startedAt).toBeGreaterThan(0);
  });

  it('查得到刚建好的训练', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, null);
    const found = await getSession(exec, s.id);
    expect(found?.id).toBe(s.id);
    expect(found?.name).toBeNull();
  });

  it('getActiveSession 返回未结束的那一次', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日');
    const active = await getActiveSession(exec);
    expect(active?.id).toBe(s.id);
  });

  it('训练结束后 getActiveSession 返回 null', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日');
    await finishSession(exec, s.id, Date.now());
    expect(await getActiveSession(exec)).toBeNull();
  });

  it('存在多条未结束记录时只返回最新的一条（模拟崩溃后残留）', async () => {
    const exec = await createMigratedExecutor();
    await createSession(exec, '旧的一场');
    await new Promise((r) => setTimeout(r, 5));
    const newer = await createSession(exec, '新的一场');
    const active = await getActiveSession(exec);
    expect(active?.id).toBe(newer.id);
  });

  it('训练列表按开始时间倒序', async () => {
    const exec = await createMigratedExecutor();
    const first = await createSession(exec, '第一场');
    await new Promise((r) => setTimeout(r, 5));
    const second = await createSession(exec, '第二场');
    await finishSession(exec, first.id, Date.now());
    await finishSession(exec, second.id, Date.now());
    const list = await listSessions(exec, 10);
    expect(list.map((s) => s.name)).toEqual(['第二场', '第一场']);
  });

  it('往训练里加动作，position 从 0 开始递增', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日');
    const ex1 = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const ex2 = await createCustomExercise(exec, '腿举', '腿', '器械');
    const se1 = await addExerciseToSession(exec, s.id, ex1.id);
    const se2 = await addExerciseToSession(exec, s.id, ex2.id);
    expect(se1.position).toBe(0);
    expect(se2.position).toBe(1);
  });

  it('按 position 列出训练中的动作', async () => {
    const exec = await createMigratedExecutor();
    const s = await createSession(exec, '腿部日');
    const ex1 = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
    const ex2 = await createCustomExercise(exec, '腿举', '腿', '器械');
    await addExerciseToSession(exec, s.id, ex2.id);
    await addExerciseToSession(exec, s.id, ex1.id);
    const list = await listSessionExercises(exec, s.id);
    expect(list.map((se) => se.exerciseId)).toEqual([ex2.id, ex1.id]);
  });

  it('listSessions 尊重 limit', async () => {
    const exec = await createMigratedExecutor();
    for (let i = 0; i < 5; i++) {
      const s = await createSession(exec, `第 ${i} 场`);
      await finishSession(exec, s.id, Date.now());
    }
    expect((await listSessions(exec, 2)).length).toBe(2);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```powershell
npx jest --runInBand src/repositories/sessionRepo.test.ts
```

Expected: FAIL —— 找不到模块 `./sessionRepo`。

- [ ] **Step 3: 写 sessionRepo 实现**

`src/repositories/sessionRepo.ts`：

```ts
import type { SqlExecutor } from '../db/types';
import type { SessionExercise, WorkoutSession } from '../domain/types';
import { newId } from '../lib/id';

interface SessionRow {
  id: string;
  name: string | null;
  started_at: number;
  finished_at: number | null;
  note: string | null;
}

interface SessionExerciseRow {
  id: string;
  session_id: string;
  exercise_id: string;
  position: number;
  note: string | null;
}

function toSession(row: SessionRow): WorkoutSession {
  return {
    id: row.id,
    name: row.name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    note: row.note,
  };
}

function toSessionExercise(row: SessionExerciseRow): SessionExercise {
  return {
    id: row.id,
    sessionId: row.session_id,
    exerciseId: row.exercise_id,
    position: row.position,
    note: row.note,
  };
}

export async function createSession(
  exec: SqlExecutor,
  name: string | null,
): Promise<WorkoutSession> {
  const session: WorkoutSession = {
    id: newId(),
    name,
    startedAt: Date.now(),
    finishedAt: null,
    note: null,
  };
  await exec.run(
    'INSERT INTO session (id, name, started_at, finished_at, note) VALUES (?, ?, ?, NULL, NULL)',
    [session.id, session.name, session.startedAt],
  );
  return session;
}

export async function getSession(
  exec: SqlExecutor,
  id: string,
): Promise<WorkoutSession | null> {
  const row = await exec.first<SessionRow>(
    'SELECT id, name, started_at, finished_at, note FROM session WHERE id = ?',
    [id],
  );
  return row ? toSession(row) : null;
}

/**
 * 取当前进行中的训练。
 *
 * 理论上同时只该有一条未结束的记录，但 App 被强杀可能留下残留，
 * 所以按开始时间倒序取最新的一条，而不是断言唯一。
 */
export async function getActiveSession(
  exec: SqlExecutor,
): Promise<WorkoutSession | null> {
  const row = await exec.first<SessionRow>(
    `SELECT id, name, started_at, finished_at, note FROM session
     WHERE finished_at IS NULL
     ORDER BY started_at DESC
     LIMIT 1`,
  );
  return row ? toSession(row) : null;
}

export async function finishSession(
  exec: SqlExecutor,
  id: string,
  finishedAt: number,
): Promise<void> {
  await exec.run('UPDATE session SET finished_at = ? WHERE id = ?', [
    finishedAt,
    id,
  ]);
}

export async function listSessions(
  exec: SqlExecutor,
  limit: number,
): Promise<WorkoutSession[]> {
  const rows = await exec.all<SessionRow>(
    `SELECT id, name, started_at, finished_at, note FROM session
     WHERE finished_at IS NOT NULL
     ORDER BY started_at DESC
     LIMIT ?`,
    [limit],
  );
  return rows.map(toSession);
}

export async function addExerciseToSession(
  exec: SqlExecutor,
  sessionId: string,
  exerciseId: string,
): Promise<SessionExercise> {
  const row = await exec.first<{ next: number | null }>(
    'SELECT MAX(position) + 1 AS next FROM session_exercise WHERE session_id = ?',
    [sessionId],
  );
  const position = row?.next ?? 0;

  const sessionExercise: SessionExercise = {
    id: newId(),
    sessionId,
    exerciseId,
    position,
    note: null,
  };

  await exec.run(
    `INSERT INTO session_exercise (id, session_id, exercise_id, position, note)
     VALUES (?, ?, ?, ?, NULL)`,
    [sessionExercise.id, sessionId, exerciseId, position],
  );

  return sessionExercise;
}

export async function listSessionExercises(
  exec: SqlExecutor,
  sessionId: string,
): Promise<SessionExercise[]> {
  const rows = await exec.all<SessionExerciseRow>(
    `SELECT id, session_id, exercise_id, position, note FROM session_exercise
     WHERE session_id = ?
     ORDER BY position ASC`,
    [sessionId],
  );
  return rows.map(toSessionExercise);
}
```

- [ ] **Step 4: 运行 sessionRepo 测试，确认通过**

```powershell
npx jest --runInBand src/repositories/sessionRepo.test.ts
```

Expected: PASS，9 个测试全绿。

- [ ] **Step 5: 写失败的 setRepo 测试**

`src/repositories/setRepo.test.ts`：

```ts
import { createMigratedExecutor } from '../db/__tests__/nodeExecutor';
import { createCustomExercise } from './exerciseRepo';
import { addExerciseToSession, createSession } from './sessionRepo';
import {
  addSet,
  completeSet,
  endRest,
  getLastPerformance,
  listSets,
  startRest,
} from './setRepo';

async function setup() {
  const exec = await createMigratedExecutor();
  const session = await createSession(exec, '腿部日');
  const exercise = await createCustomExercise(exec, '深蹲', '腿', '杠铃');
  const se = await addExerciseToSession(exec, session.id, exercise.id);
  return { exec, session, exercise, se };
}

describe('setRepo', () => {
  it('新加的组默认未完成，休息字段为空', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);
    expect(set.isCompleted).toBe(false);
    expect(set.restSeconds).toBeNull();
    expect(set.restStartedAt).toBeNull();
    expect(set.completedAt).toBeNull();
  });

  it('组的 position 从 0 开始递增', async () => {
    const { exec, se } = await setup();
    const a = await addSet(exec, se.id, 100, 5);
    const b = await addSet(exec, se.id, 100, 5);
    expect(a.position).toBe(0);
    expect(b.position).toBe(1);
  });

  it('completeSet 写入完成时间', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);
    await completeSet(exec, set.id, 1700000000000);
    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.isCompleted).toBe(true);
    expect(reloaded.completedAt).toBe(1700000000000);
  });

  it('startRest 写入休息开始时间戳', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);
    await startRest(exec, set.id, 1700000000000);
    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.restStartedAt).toBe(1700000000000);
    expect(reloaded.restSeconds).toBeNull();
  });

  it('endRest 用时间戳差算出休息秒数，并清空 restStartedAt', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);
    await startRest(exec, set.id, 1700000000000);
    await endRest(exec, set.id, 1700000083000); // 83 秒后
    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.restSeconds).toBe(83);
    expect(reloaded.restStartedAt).toBeNull();
  });

  it('endRest 在没有 restStartedAt 时不做任何事（不写脏数据）', async () => {
    const { exec, se } = await setup();
    const set = await addSet(exec, se.id, 100, 5);
    await endRest(exec, set.id, 1700000083000);
    const [reloaded] = await listSets(exec, se.id);
    expect(reloaded.restSeconds).toBeNull();
  });

  it('listSets 按 position 排序', async () => {
    const { exec, se } = await setup();
    await addSet(exec, se.id, 100, 5);
    await addSet(exec, se.id, 100, 4);
    await addSet(exec, se.id, 100, 3);
    const list = await listSets(exec, se.id);
    expect(list.map((s) => s.reps)).toEqual([5, 4, 3]);
  });

  it('getLastPerformance 返回该动作在更早训练里的完成组', async () => {
    const { exec, exercise } = await setup();

    // 更早的一次训练
    const oldSession = await createSession(exec, '上一次');
    const oldSe = await addExerciseToSession(exec, oldSession.id, exercise.id);
    const oldSet = await addSet(exec, oldSe.id, 95, 5);
    await completeSet(exec, oldSet.id, Date.now());
    await endRest(exec, oldSet.id, Date.now());
    await exec.run('UPDATE session SET finished_at = ? WHERE id = ?', [
      Date.now(),
      oldSession.id,
    ]);

    // 当前训练
    const nowSession = await createSession(exec, '这一次');
    const nowSe = await addExerciseToSession(exec, nowSession.id, exercise.id);

    const last = await getLastPerformance(exec, exercise.id, nowSession.id);
    expect(last.length).toBe(1);
    expect(last[0].weight).toBe(95);
    expect(last[0].reps).toBe(5);
  });

  it('getLastPerformance 在没有历史时返回空数组', async () => {
    const { exec, exercise, session } = await setup();
    const last = await getLastPerformance(exec, exercise.id, session.id);
    expect(last).toEqual([]);
  });

  it('getLastPerformance 只取最近的那一次训练，不混入更早的', async () => {
    const { exec, exercise } = await setup();

    const older = await createSession(exec, '更早');
    const olderSe = await addExerciseToSession(exec, older.id, exercise.id);
    const olderSet = await addSet(exec, olderSe.id, 80, 5);
    await completeSet(exec, olderSet.id, Date.now());
    await exec.run('UPDATE session SET finished_at = ? WHERE id = ?', [
      1000,
      older.id,
    ]);

    const recent = await createSession(exec, '最近');
    const recentSe = await addExerciseToSession(exec, recent.id, exercise.id);
    const recentSet = await addSet(exec, recentSe.id, 95, 5);
    await completeSet(exec, recentSet.id, Date.now());
    await exec.run('UPDATE session SET finished_at = ? WHERE id = ?', [
      2000,
      recent.id,
    ]);

    const now = await createSession(exec, '当前');
    await addExerciseToSession(exec, now.id, exercise.id);

    const last = await getLastPerformance(exec, exercise.id, now.id);
    expect(last.map((s) => s.weight)).toEqual([95]);
  });
});
```

- [ ] **Step 6: 运行测试，确认失败**

```powershell
npx jest --runInBand src/repositories/setRepo.test.ts
```

Expected: FAIL —— 找不到模块 `./setRepo`。

- [ ] **Step 7: 写 setRepo 实现**

`src/repositories/setRepo.ts`：

```ts
import type { SqlExecutor } from '../db/types';
import type { SetEntry } from '../domain/types';
import { newId } from '../lib/id';

interface SetRow {
  id: string;
  session_exercise_id: string;
  position: number;
  weight: number;
  reps: number;
  is_completed: number;
  rest_seconds: number | null;
  rest_started_at: number | null;
  completed_at: number | null;
}

function toSetEntry(row: SetRow): SetEntry {
  return {
    id: row.id,
    sessionExerciseId: row.session_exercise_id,
    position: row.position,
    weight: row.weight,
    reps: row.reps,
    isCompleted: row.is_completed === 1,
    restSeconds: row.rest_seconds,
    restStartedAt: row.rest_started_at,
    completedAt: row.completed_at,
  };
}

const SELECT_COLUMNS = `
  id, session_exercise_id, position, weight, reps,
  is_completed, rest_seconds, rest_started_at, completed_at
`;

export async function addSet(
  exec: SqlExecutor,
  sessionExerciseId: string,
  weight: number,
  reps: number,
): Promise<SetEntry> {
  const row = await exec.first<{ next: number | null }>(
    'SELECT MAX(position) + 1 AS next FROM set_entry WHERE session_exercise_id = ?',
    [sessionExerciseId],
  );
  const position = row?.next ?? 0;

  const set: SetEntry = {
    id: newId(),
    sessionExerciseId,
    position,
    weight,
    reps,
    isCompleted: false,
    restSeconds: null,
    restStartedAt: null,
    completedAt: null,
  };

  await exec.run(
    `INSERT INTO set_entry
       (id, session_exercise_id, position, weight, reps, is_completed, rest_seconds, rest_started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL)`,
    [set.id, sessionExerciseId, position, weight, reps],
  );

  return set;
}

export async function listSets(
  exec: SqlExecutor,
  sessionExerciseId: string,
): Promise<SetEntry[]> {
  const rows = await exec.all<SetRow>(
    `SELECT ${SELECT_COLUMNS} FROM set_entry
     WHERE session_exercise_id = ?
     ORDER BY position ASC`,
    [sessionExerciseId],
  );
  return rows.map(toSetEntry);
}

/**
 * 标记一组已完成。**这一步必须立刻落盘**——训练记录的全部价值就在于不丢，
 * 不能等训练结束再统一保存。
 */
export async function completeSet(
  exec: SqlExecutor,
  setId: string,
  completedAt: number,
): Promise<void> {
  await exec.run(
    'UPDATE set_entry SET is_completed = 1, completed_at = ? WHERE id = ?',
    [completedAt, setId],
  );
}

/** 开始休息计时：只记时间戳，之后用「现在 − 这个时间戳」算时长 */
export async function startRest(
  exec: SqlExecutor,
  setId: string,
  at: number,
): Promise<void> {
  await exec.run('UPDATE set_entry SET rest_started_at = ? WHERE id = ?', [
    at,
    setId,
  ]);
}

/**
 * 结束休息计时，写入这段休息的秒数。
 * 必须基于 rest_started_at 做时间戳相减，而不是用计数器累加——
 * App 被系统挂起后计数器会停，时间戳不会。
 */
export async function endRest(
  exec: SqlExecutor,
  setId: string,
  at: number,
): Promise<void> {
  const row = await exec.first<{ rest_started_at: number | null }>(
    'SELECT rest_started_at FROM set_entry WHERE id = ?',
    [setId],
  );

  if (!row || row.rest_started_at === null) return;

  const seconds = Math.max(0, Math.round((at - row.rest_started_at) / 1000));
  await exec.run(
    'UPDATE set_entry SET rest_seconds = ?, rest_started_at = NULL WHERE id = ?',
    [seconds, setId],
  );
}

/**
 * 取某个动作在**更早的某一次训练**里的完成组，用于在记录界面上显示「上次练了多少」。
 *
 * 只取最近一次有该动作的训练：更早的数据对「这次该加多少」没有参考价值，
 * 混在一起反而会干扰。
 */
export async function getLastPerformance(
  exec: SqlExecutor,
  exerciseId: string,
  beforeSessionId: string,
): Promise<SetEntry[]> {
  const previous = await exec.first<{ id: string }>(
    `SELECT s.id AS id
       FROM session s
       JOIN session_exercise se ON se.session_id = s.id
      WHERE se.exercise_id = ?
        AND s.id <> ?
        AND s.finished_at IS NOT NULL
      ORDER BY s.started_at DESC
      LIMIT 1`,
    [exerciseId, beforeSessionId],
  );

  if (!previous) return [];

  const rows = await exec.all<SetRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM set_entry st
       JOIN session_exercise se ON se.id = st.session_exercise_id
      WHERE se.exercise_id = ?
        AND se.session_id = ?
        AND st.is_completed = 1
      ORDER BY st.position ASC`,
    [exerciseId, previous.id],
  );

  return rows.map(toSetEntry);
}
```

- [ ] **Step 8: 运行测试，确认通过**

```powershell
npx jest --runInBand src/repositories/setRepo.test.ts
```

Expected: PASS，10 个测试全绿。

- [ ] **Step 9: 跑全部测试与类型检查**

```powershell
npx jest --runInBand
npx tsc --noEmit
```

Expected: 全部 PASS（10 + 11 + 5 + 7 + 9 + 10 = 52 个测试）；`tsc` 无输出。

- [ ] **Step 10: 提交**

```powershell
git add src
git commit -m "feat(repo): 训练与组的仓储，休息计时基于时间戳，支持崩溃恢复"
```

---

### Task 7: 应用状态与训练页（开始 / 恢复训练）

**Files:**
- Create: `src/repositories/database.tsx`
- Create: `src/store/activeSession.ts`
- Create: `src/lib/keepAwake.ts`
- Modify: `app/_layout.tsx`
- Modify: `app/(tabs)/index.tsx`

**Interfaces:**
- Consumes: Task 4/5/6 的全部仓储函数
- Produces:
  - `useActiveSession`（Zustand store），字段与方法见下方代码
  - `useDatabase(): SqlExecutor | null` —— 由 `app/_layout.tsx` 提供的 Context

- [ ] **Step 1: 写数据库 Provider 与根布局**

新建 `src/repositories/database.tsx`。

**为什么放在 `src/repositories/` 而不是 `app/_layout.tsx`**：一是界面层不许直接 import `src/db/`（见全局约束）；二是从路由文件里 export 组件再给别的路由 import，会和 expo-router 的布局树形成循环依赖。

```tsx
import * as SQLite from 'expo-sqlite';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { createExpoExecutor } from '../db/expoSqlite';
import { migrate } from '../db/migrations';
import type { SqlExecutor } from '../db/types';
import { seedExercisesIfEmpty } from './exerciseRepo';

const DatabaseContext = createContext<SqlExecutor | null>(null);

export function useDatabase(): SqlExecutor {
  const exec = useContext(DatabaseContext);
  if (!exec) throw new Error('数据库尚未就绪');
  return exec;
}

export function DatabaseProvider({ children }: { children: ReactNode }) {
  const [exec, setExec] = useState<SqlExecutor | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await SQLite.openDatabaseAsync('gym.db');
        await db.execAsync('PRAGMA foreign_keys = ON');
        const executor = createExpoExecutor(db);
        await migrate(executor);
        await seedExercisesIfEmpty(executor);
        if (!cancelled) setExec(executor);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 8 }}>
          数据库初始化失败
        </Text>
        <Text style={{ textAlign: 'center', color: '#666' }}>{error}</Text>
      </View>
    );
  }

  if (!exec) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <DatabaseContext.Provider value={exec}>{children}</DatabaseContext.Provider>
  );
}
```

再新建 `app/_layout.tsx`：

```tsx
import { Stack } from 'expo-router';

import { DatabaseProvider } from '../src/repositories/database';

export default function RootLayout() {
  return (
    <DatabaseProvider>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </DatabaseProvider>
  );
}
```

- [ ] **Step 2: 写屏幕常亮工具**

`src/lib/keepAwake.ts`：

```ts
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const TAG = 'workout';

/** 训练期间保持屏幕常亮——休息计时要求屏幕不灭才准 */
export async function keepScreenAwake(): Promise<void> {
  try {
    await activateKeepAwakeAsync(TAG);
  } catch {
    // 常亮失败不应影响记录，静默忽略
  }
}

export function releaseScreenAwake(): void {
  try {
    deactivateKeepAwake(TAG);
  } catch {
    // 同上
  }
}
```

- [ ] **Step 3: 写训练状态 store**

`src/store/activeSession.ts`：

```ts
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

    // 默认挑一个还没被用过的动作，省得用户第一屏面对空列表
    const all = await listExercises(exec);
    const first = all.find((e) => e.name === '深蹲') ?? all[0];

    if (first) {
      const se = await addExerciseToSession(exec, session.id, first.id);
      const last = await getLastPerformance(exec, first.id, session.id);
      const template = last[0];
      await addSet(
        exec,
        se.id,
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

    // 先把用户填的数值写进去，再标记完成——中途失败也不会丢数据
    await exec.run('UPDATE set_entry SET weight = ?, reps = ? WHERE id = ?', [
      weight,
      reps,
      pending.id,
    ]);
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

    const resting = current.sets.find(
      (s) => s.isCompleted && s.restStartedAt !== null,
    );

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

    // 收尾：如果正处在休息中，先把这段休息结掉
    const current = exercises[currentIndex];
    const resting = current?.sets.find(
      (s) => s.isCompleted && s.restStartedAt !== null,
    );
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
```

- [ ] **Step 4: 写训练页**

`app/(tabs)/index.tsx` 覆盖为：

```tsx
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useDatabase } from '../../src/repositories/database';
import { useActiveSession } from '../../src/store/activeSession';
import { keepScreenAwake } from '../../src/lib/keepAwake';

export default function TrainTab() {
  const exec = useDatabase();
  const router = useRouter();
  const { session, loading, startNew } = useActiveSession();

  const handleStart = useCallback(async () => {
    await startNew(exec, null);
    const started = useActiveSession.getState().session;
    if (started) {
      await keepScreenAwake();
      router.push(`/session/${started.id}`);
    }
  }, [exec, router, startNew]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>训练</Text>

      {session ? (
        <Pressable
          style={styles.primaryButton}
          onPress={() => router.push(`/session/${session.id}`)}
        >
          <Text style={styles.primaryButtonText}>继续上次训练</Text>
        </Pressable>
      ) : null}

      <Pressable
        style={[styles.primaryButton, session ? styles.secondaryButton : null]}
        onPress={handleStart}
        disabled={loading}
      >
        <Text
          style={[
            styles.primaryButtonText,
            session ? styles.secondaryButtonText : null,
          ]}
        >
          {session ? '开始新训练' : '开始训练'}
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
  },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  secondaryButton: { backgroundColor: '#eceef2' },
  secondaryButtonText: { color: '#4b5058' },
});
```

- [ ] **Step 5: 让训练页在进入时恢复未结束的训练**

把 `app/(tabs)/index.tsx` 的解构那一行改成：

```tsx
  const { session, loading, startNew, resume } = useActiveSession();
```

把文件顶部的 `import { useCallback } from 'react';` 改成：

```tsx
import { useCallback, useEffect } from 'react';
```

在组件内、`handleStart` 之前加入：

```tsx
  useEffect(() => {
    if (!session) {
      void resume(exec);
    }
  }, [exec, resume, session]);
```

Expected 行为：App 重启后若存在未结束的训练，「继续上次训练」按钮自动出现。

- [ ] **Step 6: 在真机上验证**

```powershell
npx expo start
```

Expected:
1. 打开 App，训练页显示「开始训练」
2. 点它 → 跳到记录界面（Task 8 会把它做完整，此刻可能只显示空白或报错，属正常）
3. 完全退出 App 再打开 → 训练页出现「继续上次训练」

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat: 数据库 Provider 与训练页的开始/恢复流程"
```

---

### Task 8: 核心记录界面（聚焦当前组，完成即落盘）

**Files:**
- Create: `app/session/[id].tsx`
- Create: `src/components/Stepper.tsx`

**Interfaces:**
- Consumes: `useActiveSession`（Task 7）、`useDatabase`（Task 7）、`getLastPerformance`（Task 6）、`keepScreenAwake`（Task 7）
- Produces: `Stepper` 组件，签名如下

```ts
interface StepperProps {
  label: string;
  value: number;
  step: number;
  min: number;
  onChange: (next: number) => void;
}
```

- [ ] **Step 1: 写加减步进组件**

`src/components/Stepper.tsx`：

```tsx
import { Pressable, StyleSheet, Text, View } from 'react-native';

interface StepperProps {
  label: string;
  value: number;
  step: number;
  min: number;
  onChange: (next: number) => void;
}

export function Stepper({ label, value, step, min, onChange }: StepperProps) {
  const decrease = () => onChange(Math.max(min, value - step));
  const increase = () => onChange(value + step);

  return (
    <View style={styles.wrapper}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Pressable
          style={styles.button}
          onPress={decrease}
          accessibilityLabel={`减少${label}`}
        >
          <Text style={styles.buttonText}>−</Text>
        </Pressable>
        <Text style={styles.value}>{value}</Text>
        <Pressable
          style={styles.button}
          onPress={increase}
          accessibilityLabel={`增加${label}`}
        >
          <Text style={styles.buttonText}>＋</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { alignItems: 'center', gap: 4 },
  label: { fontSize: 12, color: '#8a8f98' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  button: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#eceef2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 22, fontWeight: '700', color: '#4b5058' },
  value: { fontSize: 20, fontWeight: '800', minWidth: 56, textAlign: 'center' },
});
```

- [ ] **Step 2: 写记录界面**

`app/session/[id].tsx`：

```tsx
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { useDatabase } from '../../src/repositories/database';
import { Stepper } from '../../src/components/Stepper';
import { getLastPerformance } from '../../src/repositories/setRepo';
import { useActiveSession } from '../../src/store/activeSession';
import type { SetEntry } from '../../src/domain/types';

export default function SessionScreen() {
  const exec = useDatabase();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { session, exercises, currentIndex, resume, completeCurrentSet } =
    useActiveSession();

  const [weight, setWeight] = useState(20);
  const [reps, setReps] = useState(8);
  const [lastPerformance, setLastPerformance] = useState<SetEntry[]>([]);

  useEffect(() => {
    if (!session || session.id !== id) {
      void resume(exec);
    }
  }, [exec, id, resume, session]);

  const current = exercises[currentIndex];
  const currentSets = current?.sets ?? [];
  const pending: SetEntry | undefined = useMemo(
    () => currentSets.find((s) => !s.isCompleted),
    [currentSets],
  );

  // 预填：优先用上一组的数值，其次用上次训练同位置的数值
  useEffect(() => {
    if (!pending) return;
    const previousDone = [...currentSets].reverse().find((s) => s.isCompleted);
    setWeight(previousDone?.weight ?? pending.weight);
    setReps(previousDone?.reps ?? pending.reps);
  }, [pending?.id, currentSets]);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    (async () => {
      const last = await getLastPerformance(
        exec,
        current.sessionExercise.exerciseId,
        id,
      );
      if (!cancelled) setLastPerformance(last);
    })();
    return () => {
      cancelled = true;
    };
  }, [current?.sessionExercise.exerciseId, exec, id]);

  if (!session || session.id !== id) {
    return (
      <View style={styles.container}>
        <Text style={styles.hint}>载入中…</Text>
      </View>
    );
  }

  if (!current) {
    return (
      <View style={styles.container}>
        <Text style={styles.hint}>这次训练还没有动作</Text>
      </View>
    );
  }

  const completedCount = currentSets.filter((s) => s.isCompleted).length;
  const setNumber = completedCount + 1;
  const plannedSets = lastPerformance.length || 3;
  const lastSamePosition = lastPerformance[completedCount];

  const handleComplete = async () => {
    await completeCurrentSet(exec, weight, reps);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      // 无振动马达的设备上忽略
    }
  };

  // 误触「结束训练」会让人以为记录丢了，必须二次确认。
  // 无论用户选哪一项，已完成的组早就落盘了，不会丢。
  const handleFinish = () => {
    Alert.alert('结束这次训练？', '已经记录的组都会保留。', [
      { text: '继续练', style: 'cancel' },
      {
        text: '结束',
        style: 'destructive',
        onPress: () => router.replace(`/session/summary/${id}`),
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.exerciseName}>{current.exerciseName}</Text>
        <Text style={styles.setCounter}>
          第 {setNumber}
          {setNumber <= plannedSets ? ` / ${plannedSets}` : ''} 组
        </Text>
      </View>

      {lastSamePosition ? (
        <Text style={styles.lastHint}>
          上次第 {completedCount + 1} 组：{lastSamePosition.weight} kg ×{' '}
          {lastSamePosition.reps}
        </Text>
      ) : null}

      <View style={styles.bigRow}>
        <Text style={styles.bigNumber}>{weight}</Text>
        <Text style={styles.bigUnit}>kg</Text>
        <Text style={styles.bigTimes}>×</Text>
        <Text style={styles.bigNumber}>{reps}</Text>
      </View>

      <View style={styles.steppers}>
        <Stepper label="重量" value={weight} step={2.5} min={0} onChange={setWeight} />
        <Stepper label="次数" value={reps} step={1} min={1} onChange={setReps} />
      </View>

      <Pressable style={styles.completeButton} onPress={handleComplete}>
        <Text style={styles.completeButtonText}>✓　完成这组</Text>
      </Pressable>

      <Pressable style={styles.finishButton} onPress={handleFinish}>
        <Text style={styles.finishButtonText}>结束训练</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  exerciseName: { fontSize: 22, fontWeight: '700' },
  setCounter: { fontSize: 14, color: '#8a8f98' },
  lastHint: { fontSize: 13, color: '#8a8f98', textAlign: 'center' },
  bigRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  bigNumber: { fontSize: 56, fontWeight: '800', letterSpacing: -2 },
  bigUnit: { fontSize: 20, fontWeight: '600', color: '#8a8f98' },
  bigTimes: { fontSize: 24, color: '#8a8f98', marginHorizontal: 6 },
  steppers: { flexDirection: 'row', justifyContent: 'space-around' },
  completeButton: {
    backgroundColor: '#2b7fff',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
  },
  completeButtonText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  finishButton: {
    backgroundColor: '#eceef2',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  finishButtonText: { color: '#4b5058', fontSize: 14, fontWeight: '600' },
  hint: { textAlign: 'center', color: '#8a8f98', marginTop: 40 },
});
```

- [ ] **Step 3: 在真机上验证记录的完整流程**

```powershell
npx expo start
```

Expected:
1. 训练页点「开始训练」→ 进入深蹲界面，大数字显示上一次的数值
2. 点 ＋ / − 能改重量和次数
3. 点「✓ 完成这组」→ 有轻微震动，`第 N 组` 数字 +1

- [ ] **Step 4: 验证数据真的落盘了**

在记录界面完成 3 组后，**完全杀掉 App** 再打开，进入「继续上次训练」。Expected: 这 3 组仍然标记为已完成（第 N 组 显示为 4）。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: 核心记录界面，聚焦当前组，完成即落盘"
```

---

### Task 9: 休息正计时

**Files:**
- Modify: `app/session/[id].tsx`
- Create: `src/components/RestTimer.tsx`

**Interfaces:**
- Consumes: `SetEntry.restStartedAt`、`beginNextSet`（Task 7）
- Produces:

```ts
interface RestTimerProps {
  startedAt: number;
  justCompleted: { weight: number; reps: number };
  onStartNextSet: () => void;
  onSwitchExercise: () => void;
}
```

- [ ] **Step 1: 写休息计时组件**

`src/components/RestTimer.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

interface RestTimerProps {
  startedAt: number;
  justCompleted: { weight: number; reps: number };
  onStartNextSet: () => void;
  onSwitchExercise: () => void;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function RestTimer({
  startedAt,
  justCompleted,
  onStartNextSet,
  onSwitchExercise,
}: RestTimerProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // 每一次 tick 都重新读系统时间，而不是把 last + 1000 累加。
    // 这样即使 App 被系统挂起、定时器被限流，显示的时间依然是真实的经过时间。
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const elapsed = formatElapsed(now - startedAt);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>组间休息</Text>
      <Text style={styles.clock}>{elapsed}</Text>
      <Text style={styles.justDone}>
        刚刚完成　{justCompleted.weight} kg × {justCompleted.reps}
      </Text>

      <Pressable style={styles.primaryButton} onPress={onStartNextSet}>
        <Text style={styles.primaryButtonText}>开始下一组</Text>
      </Pressable>

      <Pressable onPress={onSwitchExercise}>
        <Text style={styles.link}>或 换下一个动作</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 24,
  },
  label: { fontSize: 13, color: '#8a8f98' },
  clock: {
    fontSize: 64,
    fontWeight: '800',
    letterSpacing: -2,
    fontVariant: ['tabular-nums'],
  },
  justDone: { fontSize: 13, color: '#8a8f98', marginBottom: 20 },
  primaryButton: {
    backgroundColor: '#2b7fff',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 40,
    alignItems: 'center',
    minWidth: 240,
  },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  link: { color: '#2b7fff', fontSize: 14, padding: 8 },
});
```

- [ ] **Step 2: 把休息态接到记录界面**

在 `app/session/[id].tsx` 中：

顶部 import 增加：

```tsx
import { RestTimer } from '../../src/components/RestTimer';
```

在 `useActiveSession()` 的解构中把 `beginNextSet` 取出来：

```tsx
  const {
    session,
    exercises,
    currentIndex,
    resume,
    completeCurrentSet,
    beginNextSet,
  } = useActiveSession();
```

在 `const pending` 之后加入：

```tsx
  const restingSet: SetEntry | undefined = useMemo(
    () => currentSets.find((s) => s.isCompleted && s.restStartedAt !== null),
    [currentSets],
  );
```

在 `if (!current) { ... }` 之后、`const completedCount` 之前加入休息态分支：

```tsx
  if (restingSet && restingSet.restStartedAt !== null) {
    return (
      <RestTimer
        startedAt={restingSet.restStartedAt}
        justCompleted={{ weight: restingSet.weight, reps: restingSet.reps }}
        onStartNextSet={() => void beginNextSet(exec)}
        onSwitchExercise={() => void beginNextSet(exec)}
      />
    );
  }
```

- [ ] **Step 3: 在真机上验证计时与数据**

```powershell
npx expo start
```

Expected:
1. 点「✓ 完成这组」→ 立刻切到休息界面，计时从 `00:00` 往上走
2. **把手机锁屏等 30 秒，再解锁** → 计时显示 `00:3x`，没有停在 30 秒之前（验证用的是时间戳而不是计数器）
3. 点「开始下一组」→ 回到记录界面，`第 N 组` 数字已 +1

- [ ] **Step 4: 验证休息时长确实落库**

完成一次「完成这组 → 等约 20 秒 → 开始下一组」，然后杀掉 App 重开并回到该训练。当前画面会重置到第一组，但只要观察到该组不再处于休息态即可（休息结束后 `restStartedAt` 被清空）。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: 组间休息正计时，基于时间戳不受挂起影响"
```

---

### Task 10: 训练总结页

**Files:**
- Create: `app/session/summary/[id].tsx`

**Interfaces:**
- Consumes: `totalVolumeLoad`、`estimateOneRepMax`（Task 2）、`buildRestFeedback`（Task 3）、`endWorkout`（Task 7）、`listSessions`/`getSession`（Task 6）
- Produces: 可查看本次训练统计与休息回顾的页面

- [ ] **Step 1: 写总结页**

`app/session/summary/[id].tsx`：

```tsx
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useDatabase } from '../../../src/repositories/database';
import { buildRestFeedback, type RestFeedback } from '../../../src/domain/restAdvice';
import { estimateOneRepMax, totalVolumeLoad } from '../../../src/domain/metrics';
import { listSessionExercises, getSession } from '../../../src/repositories/sessionRepo';
import { getExercise } from '../../../src/repositories/exerciseRepo';
import { listSets } from '../../../src/repositories/setRepo';
import { useActiveSession } from '../../../src/store/activeSession';
import { releaseScreenAwake } from '../../../src/lib/keepAwake';
import type { WorkoutSession } from '../../../src/domain/types';

interface ExerciseSummary {
  name: string;
  repsList: number[];
  restList: (number | null)[];
  totalSets: number;
  volume: number;
  bestE1RM: number | null;
  feedback: RestFeedback | null;
}

export default function SummaryScreen() {
  const exec = useDatabase();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const endWorkout = useActiveSession((s) => s.endWorkout);

  const [session, setSession] = useState<WorkoutSession | null>(null);
  const [summaries, setSummaries] = useState<ExerciseSummary[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sessionExercises = await listSessionExercises(exec, id);
      const result: ExerciseSummary[] = [];

      for (const se of sessionExercises) {
        const sets = await listSets(exec, se.id);
        const completed = sets.filter((s) => s.isCompleted);
        if (completed.length === 0) continue;

        const exercise = await getExercise(exec, se.exerciseId);
        const repsList = completed.map((s) => s.reps);
        const restList = completed.map((s) => s.restSeconds);

        result.push({
          name: exercise?.name ?? '未知动作',
          repsList,
          restList,
          totalSets: completed.length,
          volume: totalVolumeLoad(completed),
          bestE1RM: Math.max(
            ...completed.map((s) => estimateOneRepMax(s.weight, s.reps) ?? 0),
          ) || null,
          feedback: buildRestFeedback(repsList, restList),
        });
      }

      const current = await getSession(exec, id);
      if (!cancelled) {
        setSession(current);
        setSummaries(result);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [exec, id]);

  const totals = useMemo(() => {
    const totalSets = summaries.reduce((n, s) => n + s.totalSets, 0);
    const volume = summaries.reduce((n, s) => n + s.volume, 0);
    const minutes =
      session?.finishedAt && session?.startedAt
        ? Math.round((session.finishedAt - session.startedAt) / 60000)
        : 0;
    return { totalSets, volume, minutes };
  }, [summaries, session]);

  const handleSave = async () => {
    setSaving(true);
    await endWorkout(exec);
    releaseScreenAwake();
    setSaving(false);
    router.replace('/(tabs)');
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{totals.minutes}</Text>
          <Text style={styles.statLabel}>分钟</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{totals.totalSets}</Text>
          <Text style={styles.statLabel}>总组数</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{Math.round(totals.volume)}</Text>
          <Text style={styles.statLabel}>总容量 kg</Text>
        </View>
      </View>

      <Text style={styles.sectionLabel}>组间休息回顾（粗略参考）</Text>

      {summaries.length === 0 ? (
        <Text style={styles.empty}>这次训练还没有完成的组</Text>
      ) : (
        summaries.map((s, index) => (
          <View key={`${s.name}-${index}`} style={styles.card}>
            <Text style={styles.repsArray}>{s.repsList.join(' / ')}</Text>
            {s.feedback ? (
              <Text style={styles.feedback}>{s.feedback.message}</Text>
            ) : (
              <Text style={styles.feedbackMuted}>
                组数不足 3 组，暂不判断
              </Text>
            )}
          </View>
        ))
      )}

      <Pressable
        style={[styles.saveButton, saving ? styles.saveButtonDisabled : null]}
        onPress={handleSave}
        disabled={saving}
      >
        <Text style={styles.saveButtonText}>保存这次训练</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 14 },
  statsRow: { flexDirection: 'row', gap: 10 },
  stat: {
    flex: 1,
    backgroundColor: '#f4f5f7',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  statValue: { fontSize: 20, fontWeight: '800' },
  statLabel: { fontSize: 11, color: '#8a8f98' },
  sectionLabel: {
    fontSize: 12,
    color: '#6b7280',
    letterSpacing: 0.6,
    marginTop: 6,
  },
  card: { backgroundColor: '#f4f5f7', borderRadius: 12, padding: 14, gap: 6 },
  repsArray: { fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
  feedback: { fontSize: 13, color: '#4b5058', lineHeight: 19 },
  feedbackMuted: { fontSize: 13, color: '#a0a4ab' },
  empty: { color: '#8a8f98', fontSize: 13 },
  saveButton: {
    backgroundColor: '#16181d',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 10,
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
```

- [ ] **Step 2: 在真机上验证总结页**

```powershell
npx expo start
```

Expected:
1. 记录界面点「结束训练」→ 进入总结页
2. 顶部显示分钟 / 总组数 / 总容量
3. 每个动作一张卡片，**第一行是原始次数数组**（如 `5 / 5 / 5 / 3`），下面是提示文案
4. 标题明确写着「粗略参考」
5. 只做了 2 组的动作显示「组数不足 3 组，暂不判断」

- [ ] **Step 3: 提交**

```powershell
git add -A
git commit -m "feat: 训练总结页，展示次数数组与粗略休息回顾"
```

---

### Task 11: M2 端到端验收

**Files:**
- Create: `docs/superpowers/plans/m2-acceptance-checklist.md`

**Interfaces:**
- Consumes: 全部
- Produces: 一份用户能照着走的验收清单

- [ ] **Step 1: 跑完整测试与类型检查**

```powershell
npx jest --runInBand
npx tsc --noEmit
```

Expected: 52 个测试全部 PASS；`tsc` 无输出。

- [ ] **Step 2: 写验收清单文档**

`docs/superpowers/plans/m2-acceptance-checklist.md`：

```markdown
# M2 验收清单

对照设计文档 §2.3 的成功标准逐条验证。全部在真机上手动完成。

## 1. 一组做完到记录完成 ≤ 2 次点击

- [ ] 进入训练界面后，点「✓ 完成这组」即完成记录（1 次点击）
- [ ] 点「开始下一组」回到记录态（1 次点击）
- [ ] 全程无需手动输入数字（数值已预填）

## 2. 记录过程不打断训练节奏

- [ ] 屏幕在训练期间保持常亮
- [ ] 完成一组时有轻微震动反馈
- [ ] 组间休息是正计时，不会催促

## 3. 训练记录永不丢失

- [ ] 完成 3 组后强杀 App，重开后「继续上次训练」按钮出现
- [ ] 进入后已完成的组数正确
- [ ] 休息途中强杀 App，重开后计时显示的是真实经过时间

## 4. 训练结束后能看到次数对比与粗略提示

- [ ] 总结页顶部三个数字（分钟 / 总组数 / 总容量）正确
- [ ] 每个动作卡片第一行是原始次数数组
- [ ] 提示文案与次数数组一致（例如掉了 2 次却说「稳住了」即为 bug）
- [ ] 页面标注了「粗略参考」
- [ ] 少于 3 组的动作显示「组数不足 3 组，暂不判断」

## 5. 数值口径抽查

- [ ] 手工核算总容量：Σ(重量 × 次数)，只算已完成的组
- [ ] 确认没有任何地方显示 e1RM（v1 的 M4 才做）

## 6. 数据落地检查

- [ ] 「保存这次训练」后，训练页不再显示「继续上次训练」
- [ ] 重启 App 后训练页正常，不出现两条进行中的训练
```

- [ ] **Step 3: 按清单逐条验收**

在真机上完整走一遍上面的清单。任何一条不通过，回到对应任务修复，不要跳过。

- [ ] **Step 4: 提交**

```powershell
git add -A
git commit -m "docs: M2 验收清单"
```

---

## 完成之后

M2 达成即达到设计文档里说的关键节点：**这个 App 已经可以真的带去健身房用了。**

后面 M3–M7（历史、进步、备份、休息回顾增强、出 APK）**不在本计划范围内**，等 M2 经过一到两周真实使用验证之后，再单独写计划。理由：这些功能的取舍取决于真实使用中暴露的问题，现在写死细节是浪费。
