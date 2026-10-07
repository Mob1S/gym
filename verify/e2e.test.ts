/**
 * 端到端回归：在真实 SQLite 上把五条主旅程串起来跑。
 *
 * ## 为什么需要它
 *
 * `src/` 下的测试全部是**分层**的：仓储测仓储、store 测 store、纯函数测纯函数。
 * 分层全绿仍然可能因为层与层之间的假设不一致而在真机上坏掉 —— 例如
 * 「按计划开训练 → 练完 → 结束 → 再看轮转」跨了 rotation / templateRepo /
 * sessionRepo / setRepo / activeSession 五处，而**没有任何一个分层测试覆盖这条链**。
 * 这个文件补的就是这条链。
 *
 * 实测价值：它第一次跑就抓出了「keep 之后已记过组的动作摘不掉」这个问题 ——
 * 那处判据在分层测试里当时也写错了（写成「一行 set 都没有」，而 keep 会保留
 * 已完成的组，条件恒不成立）。两边同时写错的时候，只有端到端能发现。
 *
 * ## 为什么放在 `src/` 外面
 *
 * `jest.config.js` 的 `testMatch` 是 `<rootDir>/src/**\/*.test.ts`，这个文件不在
 * 其中，所以 `npx jest` **不会**带上它。这不是遗漏 —— 它比单元测试慢、而且
 * 只关心「链有没有断」，不该混进日常的快速反馈里。要跑它用：
 *
 * ```
 * npm run verify:e2e
 * ```
 *
 * ## 它不覆盖什么
 *
 * 渲染、手势、原生模块、以及真机上 `expo-sqlite` 与这里 `node:sqlite` 的实现差异。
 * 因此它**不能替代真机验收**，只能保证「数据层与 store 的判断串起来是对的」。
 */
import { migrate } from '../src/db/migrations';
import { createNodeExecutor } from '../src/db/__tests__/nodeExecutor';
import type { SqlExecutor } from '../src/db/types';
import type { ImportedWorkout } from '../src/domain/importRecords';
import { importWorkouts } from '../src/repositories/importRepo';
import { listCompletedSetPoints, listTrainedExercises } from '../src/repositories/progressRepo';
import { createCustomExercise, listExercises } from '../src/repositories/exerciseRepo';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  moveTemplate,
  setTemplateExercises,
} from '../src/repositories/templateRepo';
import {
  deleteSession,
  getSession,
  listSessionSummaries,
  listSessions,
} from '../src/repositories/sessionRepo';
import { useActiveSession } from '../src/store/activeSession';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}\n      期望 ${e}\n      实得 ${a}`);
  }
}

async function freshDb(): Promise<SqlExecutor> {
  const { exec } = createNodeExecutor();
  await migrate(exec);
  return exec;
}

async function exerciseIds(exec: SqlExecutor, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    ids.push((await createCustomExercise(exec, name, '胸', '杠铃')).id);
  }
  return ids;
}

/** 一场训练：每个动作做 2 组，然后结束 */
async function trainOnce(exec: SqlExecutor, store: typeof useActiveSession, name: string) {
  const result = await store.getState().startNew(exec, name);
  for (const _ of useActiveSession.getState().exercises) {
    await store.getState().completeCurrentSet(exec, 100, 5);
    await store.getState().completeCurrentSet(exec, 100, 5);
  }
  const id = await store.getState().endWorkout(exec);
  return { result, id };
}

async function main(): Promise<number> {
  // ─────────────────────────────────────────────────────────────
  console.log('\n【旅程 1】分化循环：建计划 → 连练四场 → 轮转绕回');
  {
    const exec = await freshDb();
    useActiveSession.getState().reset();

    const [bench, fly, row, squat] = await exerciseIds(exec, [
      '卧推', '飞鸟', '划船', '深蹲',
    ]);
    const push = await createTemplate(exec, '推日');
    const pull = await createTemplate(exec, '拉日');
    const legs = await createTemplate(exec, '腿日');
    await setTemplateExercises(exec, push.id, [bench, fly]);
    await setTemplateExercises(exec, pull.id, [row]);
    await setTemplateExercises(exec, legs.id, [squat]);

    const seen: (string | null)[] = [];
    for (let i = 0; i < 4; i += 1) {
      await trainOnce(exec, useActiveSession, `第 ${i + 1} 场`);
      // endWorkout 会清空 store，所以从库里读这一场用的模板
      const latest = await listSessions(exec, 1);
      seen.push(latest[0].templateId);
    }

    check('四场依次是 推/拉/腿/推', seen, [push.id, pull.id, legs.id, push.id]);

    const first = await listSessions(exec, 10);
    const pushSession = first.find((s) => s.templateId === push.id)!;
    check(
      '按计划开的那一场，动作清单就是计划里的两个',
      (await exec.all<{ name: string }>(
        `SELECT e.name FROM session_exercise se JOIN exercise e ON e.id = se.exercise_id
          WHERE se.session_id = ? ORDER BY se.position`,
        [pushSession.id],
      )).map((r) => r.name),
      ['卧推', '飞鸟'],
    );
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n【旅程 2】训练中删动作：两条分支各自的结果');
  {
    const exec = await freshDb();
    useActiveSession.getState().reset();
    const [bench, fly, row] = await exerciseIds(exec, ['卧推', '飞鸟', '划船']);

    await useActiveSession.getState().startNew(exec, '删动作测试');
    await useActiveSession.getState().addExercise(exec, bench);
    await useActiveSession.getState().completeCurrentSet(exec, 60, 8);
    await useActiveSession.getState().completeCurrentSet(exec, 60, 8);
    await useActiveSession.getState().addExercise(exec, fly);
    await useActiveSession.getState().addExercise(exec, row);

    const sessionId = useActiveSession.getState().session!.id;
    const benchSe = useActiveSession.getState().exercises[0].sessionExercise.id;
    const flySe = useActiveSession.getState().exercises[1].sessionExercise.id;

    // 「删掉这 2 组」：动作与组一起消失
    await useActiveSession.getState().removeExercise(exec, benchSe, 'delete');
    check(
      "delete 之后清单里没有卧推",
      useActiveSession.getState().exercises.map((e) => e.exerciseName),
      ['飞鸟', '划船'],
    );
    const afterDelete = await exec.first<{ n: number }>(
      'SELECT COUNT(*) AS n FROM session_exercise WHERE session_id = ?',
      [sessionId],
    );
    check('delete 之后库里只剩 2 个动作', Number(afterDelete?.n), 2);
    const positions = await exec.all<{ position: number }>(
      'SELECT position FROM session_exercise WHERE session_id = ? ORDER BY position',
      [sessionId],
    );
    check('剩下动作的 position 重排成 0,1', positions.map((r) => r.position), [0, 1]);

    // 「先留着」：**必须用一个已经记过组的动作来测**。
    // 这里是最容易坏的一处：`keep` 只删未完成的占位组、保留已完成的组，
    // 所以被摘掉的动作在库里并不是「一行 set 都没有」。判据若写成
    // 「sets 为空」就恒不成立、动作原地不动 —— 用户点了「先留着」却看见
    // 它还在，而分层测试里那条用例当时也写错了判据（实施时才发现）。
    await useActiveSession.getState().removeExercise(exec, flySe, 'keep');
    check(
      "keep 之后清单里没有飞鸟（它没记过组）",
      useActiveSession.getState().exercises.map((e) => e.exerciseName),
      ['划船'],
    );
    const flyRow = await exec.first<{ n: number }>(
      'SELECT COUNT(*) AS n FROM session_exercise WHERE id = ?',
      [flySe],
    );
    check('keep 之后 session_exercise 那一行还在（只是界面不显示）', Number(flyRow?.n), 1);

    // 关键场景：先给「划船」记 2 组，再选「先留着」
    const rowSe = useActiveSession.getState().exercises[0].sessionExercise.id;
    await useActiveSession.getState().completeCurrentSet(exec, 70, 6);
    await useActiveSession.getState().completeCurrentSet(exec, 70, 6);
    await useActiveSession.getState().addExercise(exec, fly); // 再塞一个动作，好让清单非空

    await useActiveSession.getState().removeExercise(exec, rowSe, 'keep');
    check(
      '记过 2 组的动作选 keep 后，清单里也没有它了',
      useActiveSession.getState().exercises.map((e) => e.exerciseName),
      ['飞鸟'],
    );
    const rowKept = await exec.all<{ is_completed: number }>(
      'SELECT is_completed FROM set_entry WHERE session_exercise_id = ? ORDER BY position',
      [rowSe],
    );
    check(
      '而它那 2 组已完成的组仍在库里、未完成的占位组被删掉',
      rowKept.map((r) => r.is_completed),
      [1, 1],
    );

    await useActiveSession.getState().endWorkout(exec);
    const summary = await listSessionSummaries(exec, 10);
    check(
      '这一场历史里是 3 组（卧推 2 组已删、划船 2 组留下、飞鸟 0 组）',
      summary[0].setCount,
      2,
    );
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n【旅程 3】导入旧记录 → 进步曲线接得上 → 删掉那一场');
  {
    const exec = await freshDb();
    useActiveSession.getState().reset();

    // 先在本机练两场「深蹲」，形成一条已有的曲线
    const [squat] = await exerciseIds(exec, ['深蹲']);
    for (let i = 0; i < 2; i += 1) {
      await useActiveSession.getState().startNew(exec, `本机第 ${i + 1} 场`);
      await useActiveSession.getState().addExercise(exec, squat);
      await useActiveSession.getState().completeCurrentSet(exec, 100 + i * 5, 5);
      await useActiveSession.getState().endWorkout(exec);
    }

    // 再导入三场更早的旧记录（同名动作「深蹲」，应当接到同一条曲线上）
    const legacy: ImportedWorkout[] = [0, 1, 2].map((i) => ({
      startedAt: T0 + i * DAY,
      finishedAt: T0 + i * DAY + 3_600_000,
      name: '旧记录',
      exercises: [
        { name: '深蹲', sets: [{ weight: 80 + i * 5, reps: 5 }, { weight: 80 + i * 5, reps: 5 }] },
        { name: '腿举', sets: [{ weight: 150, reps: 10 }] },
      ],
    }));
    const result = await importWorkouts(exec, legacy);
    check('导入 3 场', result.sessions, 3);
    check('新建 1 个动作（腿举），深蹲复用', result.createdExercises, 1);
    check('动作库里只有一个「深蹲」', (await listExercises(exec)).filter((e) => e.name === '深蹲').length, 1);

    const points = await listCompletedSetPoints(exec);
    const squatPoints = points.filter((p) => p.exerciseId === squat);
    check('深蹲曲线上的点 = 本机 2 + 导入 6', squatPoints.length, 8);
    check(
      '曲线按时间升序（最早的旧记录在最前）',
      squatPoints[0].weight,
      80,
    );
    const trained = await listTrainedExercises(exec);
    check('进步页列表里有深蹲与腿举', trained.map((t) => t.name).sort(), ['深蹲', '腿举']);

    // 删掉中间那场导入的记录，曲线必须少两个点
    const importedSessions = (await listSessions(exec, 10)).filter((s) => s.name === '旧记录');
    await deleteSession(exec, importedSessions[1].id);
    const after = (await listCompletedSetPoints(exec)).filter((p) => p.exerciseId === squat);
    check('删掉一场导入记录后，深蹲的点少 2 个', after.length, 6);
    check('历史里只剩 4 场', (await listSessionSummaries(exec, 10)).length, 4);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n【旅程 4】不建计划的用户：行为与升级前一致');
  {
    const exec = await freshDb();
    useActiveSession.getState().reset();
    const [bench, fly] = await exerciseIds(exec, ['卧推', '飞鸟']);

    // 一场都不按计划练（第一场手动加动作，第二场应当复制第一场）
    await useActiveSession.getState().startNew(exec, '第一场');
    await useActiveSession.getState().addExercise(exec, bench);
    await useActiveSession.getState().addExercise(exec, fly);
    const firstId = await useActiveSession.getState().endWorkout(exec);

    check('一场计划都没有时，startNew 仍返回 started', await useActiveSession.getState().startNew(exec, '第二场'), 'started');
    check(
      '第二场复制了第一场的动作',
      useActiveSession.getState().exercises.map((e) => e.exerciseName),
      ['卧推', '飞鸟'],
    );
    check('第二场不按任何计划', useActiveSession.getState().session?.templateId, null);

    // 删掉第一场，第二场不受影响
    await useActiveSession.getState().endWorkout(exec);
    await deleteSession(exec, firstId!);
    check('删掉一场后，另一场还在', (await listSessionSummaries(exec, 10)).length, 1);
    check('被删的那一场取不到了', await getSession(exec, firstId!), null);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n【旅程 5】删计划不伤历史 + 上移下移真的换位');
  {
    const exec = await freshDb();
    useActiveSession.getState().reset();
    const [bench, row, squat] = await exerciseIds(exec, ['卧推', '划船', '深蹲']);
    const push = await createTemplate(exec, '推日');
    const pull = await createTemplate(exec, '拉日');
    const legs = await createTemplate(exec, '腿日');
    await setTemplateExercises(exec, push.id, [bench]);
    await setTemplateExercises(exec, pull.id, [row]);
    await setTemplateExercises(exec, legs.id, [squat]);

    await trainOnce(exec, useActiveSession, '推日那场');
    check('第一场按推日', (await listSessions(exec, 1))[0].templateId, push.id);

    check('上移「拉日」后顺序变成 拉/推/腿', (await (async () => {
      await moveTemplate(exec, 1, 0);
      return (await listTemplates(exec)).map((t) => t.name);
    })()), ['拉日', '推日', '腿日']);

    // 删掉推日：用它练过的那一场必须还在，只是不再指向任何计划
    const affected = await deleteTemplate(exec, push.id);
    check('删计划时报告有 1 场历史受影响', affected.affectedSessions, 1);
    const historyAfter = await listSessions(exec, 10);
    check('历史记录还在', historyAfter.length, 1);
    check('那一场不再指向任何计划', historyAfter[0].templateId, null);
    check('计划列表剩两套且 position 无空洞', (await listTemplates(exec)).map((t) => t.position), [0, 1]);

    // 轮转遇到「上一场的计划已被删」时必须回到第一套
    check('删掉当前计划后，下一场回到第一套（拉日）', await useActiveSession.getState().startNew(exec, '下一场'), 'started');
    const next = (await listTemplates(exec))[0];
    check('确实用了第一套', useActiveSession.getState().session?.templateId, next.id);
    check('而第一套的动作被带进来了', useActiveSession.getState().exercises.map((e) => e.exerciseName), [next.id === pull.id ? '划船' : '深蹲']);
    check('计划详情能正常读出动作名', (await getTemplate(exec, next.id))?.exercises.length, 1);
  }

  console.log(
    failures === 0
      ? '\n════ 全部通过 ════\n'
      : `\n════ 有 ${failures} 处不符合预期 ════\n`,
  );
  return failures;
}

// 包成一条测试，这样 jest 的退出码才有意义。直接 `void main()` 的话这个 suite
// 里没有任何 it，jest 会报「must contain at least one test」—— 结果反而是
// 「看不出真实结论」。
it('五条主旅程在真实 SQLite 上串起来跑通', async () => {
  await expect(main()).resolves.toBe(0);
});
