import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Pressable, View } from 'react-native';

import { nextTemplateIndex } from '../../src/domain/rotation';
import { formatDateTime } from '../../src/lib/format';
import { keepScreenAwake } from '../../src/lib/keepAwake';
import { describeExercises } from '../../src/lib/sessionLabel';
import { useDatabase } from '../../src/repositories/database';
import { findLatestTemplateId } from '../../src/repositories/sessionRepo';
import {
  getTemplate,
  listTemplates,
  type TemplateSummary,
} from '../../src/repositories/templateRepo';
import { useActiveSession } from '../../src/store/activeSession';
import { Button, Card, Screen, Text, radius, space, usePalette } from '../../src/ui';

/**
 * 训练标签页（首页）。
 *
 * 这一屏刻意只有两件事：开始一场新训练，或者接着练没做完的那一场。没有
 * 进行中的训练时，「继续」那块根本不渲染 —— 越靠健身房的场景，入口越不该需要找。
 *
 * 有进行中的训练时，**「继续」是唯一的主按钮**（橙色实底），「开始新训练」降级成
 * 次级按钮。这个主次关系很重要：从裤兜里掏出手机的那一刻，用户要的是回到刚才那场，
 * 而不是新开一场。
 *
 * 编排过分化计划之后，这一屏还多回答一个问题：**今天该练哪一套**。它只在没有
 * 进行中的训练时出现，永远排在主按钮上面 —— 它是「要不要开始」的依据，而不是
 * 「接着练那一场」的干扰。
 *
 * 真正的记录界面在 `session/[id]`，这一页只负责「进哪一场」这个决策。
 *
 * @returns 首页；取数期间按钮禁用，但不会白屏
 */
export default function TrainTab() {
  const exec = useDatabase();
  const router = useRouter();
  const palette = usePalette();
  // 这一屏要用的 store 切片：进行中的训练、它的动作列表，以及几个会写库的动作
  const {
    session,
    exercises,
    loading,
    startNew,
    startNewWithTemplate,
    resume,
    endWorkout,
  } = useActiveSession();

  // 只有「还没结束」的才算当前训练，必须在 finishedAt 上判，而不是「有没有
  // session」—— 后者曾经让一场已经结束、只是还留在内存里的训练也长出一个
  // 「继续上次训练」按钮，点进去还能接着往里记组。
  //
  // 窄化成 `current` 而不是留一个 boolean：`session` 的类型是
  // `WorkoutSession | null`，从 boolean 变量推不出它非空，JSX 里直接写
  // `session.id` 过不了 tsc。
  const current =
    session !== null && session.finishedAt === null ? session : null;

  // 「今天该练哪套」：默认是轮转算出来的那套，用户可以在弹层里改。
  // **只存在本地 state 里，不落库** —— 用户没点「开始训练」之前什么都没发生，
  // 一旦落库就等于替他记了一个决定；而这一场真正开始时会把选中的 id 写进
  // session.template_id，轮转指针自然跟着走。
  const [plannedId, setPlannedId] = useState<string | null>(null);
  // 计划清单 + 选中那套的动作名，用来在卡片上显示「背 等 6 个动作」
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [plannedNames, setPlannedNames] = useState<string[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  // 取数的触发器。`current` 变化本身盖不住两种情形：训练是在记录页结束的
  // （这个组件全程没有重新挂载），以及用户刚从计划页删掉/改动了计划 ——
  // 两种情况下首页都常驻在返回栈上，只有重新进入这一屏才能拿到新的数据。
  const [refreshKey, setRefreshKey] = useState(0);

  // App 被强杀或用户切走再回来时，库里可能还留着一条未结束的训练，
  // 进入训练页先把它捡回来，「继续上次训练」按钮才会自动出现。
  useEffect(() => {
    if (!session) {
      void resume(exec);
    }
  }, [exec, resume, session]);

  // 算「今天该练哪套」，并把它那套的动作名一起取回来填进卡片。
  useEffect(() => {
    // 有进行中的训练时这张卡片根本不渲染，一次库都不用查
    if (current) return;
    // `loading` 期间 store 里可能还留着一场没结束的训练没被 resume 装回来
    // （首帧的 `session` 必然是 null）。不等它的话，会先按「没有进行中的训练」
    // 把计划卡片画出来，几百毫秒后再被「进行中」卡片顶掉 —— 一个假闪现。
    // 计划卡片只是补充信息，晚一帧出现无妨，宁可不闪。
    if (loading) return;

    let cancelled = false;
    void (async () => {
      // 「一共有哪些计划」和「最近按哪套练的」互不依赖，并发取
      const [all, lastTemplateId] = await Promise.all([
        listTemplates(exec),
        findLatestTemplateId(exec),
      ]);
      if (cancelled) return;

      // 一个计划都没有时 index 是 null —— 卡片整个不渲染，界面回到升级前的样子
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
  }, [exec, current, loading, refreshKey]);

  // 每次重新进入首页都重算一次。用 `useFocusEffect` 而不是再挂一个 `useEffect`：
  // 用户从计划页删掉全部计划回来后，卡片必须马上消失（否则它会指着一个已经不存在
  // 的计划）；而标签页在返回栈上常驻，`useEffect` 不会再跑第二次。
  useFocusEffect(
    useCallback(() => {
      setRefreshKey((key) => key + 1);
    }, []),
  );

  /**
   * 进入某一场的记录界面。申请屏幕常亮放在这里而不是记录页内部：从别处深链
   * 直接打开 `session/[id]` 时走的不是这条路，不会白白常亮一屏。
   *
   * 常亮申请是 fire-and-forget（`void`），失败也不该拦住导航 —— 拿不到常亮
   * 总比点不动按钮强。
   *
   * @param id 目标训练的 id（workout_session.id，不是 exercise.id）
   */
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

  /**
   * 打开 store 里当前那一场。刻意现读 `getState()` 而不是用组件里那个
   * `session`：`handleStart` 里可能刚结束旧场、又新建一场，闭包里的
   * `session` 还是上一次渲染的值，用它会把用户送回已经结束的那一场。
   *
   * @returns 无返回值；store 里没有训练时静默什么都不做
   */
  const openCurrent = useCallback(async () => {
    const started = useActiveSession.getState().session;
    if (started) openSession(started.id);
  }, [openSession]);

  /**
   * 「开始训练」按钮：新建一场，撞上未结束的训练时改弹二选一。
   *
   * 第二个参数是训练名，传 `null` 表示「先不起名」（界面上显示「未命名训练」）。
   * 至于练什么：卡上选定了计划就用 `startNewWithTemplate` 明确指定那一套；
   * 一个计划都没有时才退回旧的 `startNew`，由它按轮转算/复制上一次训练的动作
   * 清单，第一次用 App 没有历史可复制时就是一场空训练，由记录页的「添加动作」接住。
   *
   * 弹窗那条分支不 await 用户的选择就返回了：按钮到此为止，接下来去哪一场
   * 由用户点的那个按钮决定。
   *
   * @returns 无返回值
   */
  const handleStart = useCallback(async () => {
    // 绝不能把 `plannedId` 直接塞给 `startNew` 的第三个参数：那里的 `undefined`
    // 有确切含义（按轮转算），而 `plannedId` 是 null 时语义完全不同 —— 混用会让
    // 轮转永远失效。「绕开轮转」必须走这个名字明确的方法。
    const result = plannedId
      ? await startNewWithTemplate(exec, null, plannedId)
      : await startNew(exec, null);

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
                // 刚结束的那一场正是「最近一场按计划练的训练」，轮转指针因此
                // 往前走了一格 —— 重算一次，用户退回来时卡片已经是下一套了
                setRefreshKey((key) => key + 1);
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
  }, [
    endWorkout,
    exec,
    openCurrent,
    openSession,
    plannedId,
    startNew,
    startNewWithTemplate,
  ]);

  /**
   * 在弹层里换一套计划。**只改本地 state**：还没点「开始训练」，什么都没发生；
   * 用户点开始之后这一场才会按新选的那套走。
   *
   * @param id 选中的 `split_template.id`
   * @returns 无返回值；弹层关掉，卡片上的名字、动作说明跟着换
   */
  const choosePlan = useCallback((id: string) => {
    setPlannedId(id);
    setPickerVisible(false);
  }, []);

  /**
   * 从弹层去计划页编排计划。先关弹层再导航，否则返回时弹层还盖在上面。
   *
   * @returns 无返回值
   */
  const openPlanList = useCallback(() => {
    setPickerVisible(false);
    router.push('/plan');
  }, [router]);

  // 换计划的弹层。抽成变量放在 JSX 外面，跟 `session/[id]` 里的 `pickerModal`
  // 同一个写法：它是叠在整屏之上的一层，不该混进主内容的阅读顺序里。
  //
  // 用 `Modal` 而不是 `Alert`：`Alert` 在 Android 上最多三个按钮，而计划有几套
  // 完全由用户决定。
  //
  // 底部 sheet 的结构照 `session/[id]` 的 pickerModal（背景 Pressable 关掉 +
  // 底部 sheet）。那份用的是 `StyleSheet`，而这个文件全用内联样式 —— 两种写法
  // 混在一起比多写几行更糟，所以这里不引 `StyleSheet`。
  const pickerModal = (
    <Modal
      visible={pickerVisible}
      transparent
      animationType="slide"
      // Android 的物理返回键 / 手势返回：不接这个回调，返回键会直接退出这一屏
      onRequestClose={() => setPickerVisible(false)}
    >
      {/* 铺满整屏、内容贴底：sheet 从下面升上来 */}
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        {/* 背景层。不用 `StyleSheet.absoluteFillObject` —— 这一版 react-native
            的类型里已经没有这个导出，直接写全 absolute 四边更省事（同 `session/[id]`） */}
        <Pressable
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.55)',
          }}
          onPress={() => setPickerVisible(false)}
        />
        <View
          style={{
            backgroundColor: palette.surface,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            paddingHorizontal: space.lg,
            paddingTop: space.lg,
            paddingBottom: space.xl,
            gap: space.md,
          }}
        >
          <Text variant="title">今天练哪一套</Text>
          {/* 这个功能的全部规则就这一句：换的计划只管这一场，不动轮转的顺序 */}
          <Text variant="caption" color="textMuted">
            选了就是这一场练它；下一场还是按顺序轮转。
          </Text>

          {templates.map((template) => (
            <Pressable
              key={template.id}
              style={{
                paddingVertical: space.md,
                borderBottomWidth: 1,
                borderBottomColor: palette.border,
              }}
              onPress={() => choosePlan(template.id)}
              accessibilityRole="button"
              accessibilityLabel={`练${template.name}`}
            >
              <Text variant="body">{template.name}</Text>
              {/* 「· 已选」而不是在名字前加勾：这里不引图标，一行字就够，
                  而且窄屏上也不会把计划名挤断 */}
              <Text
                variant="caption"
                color="textMuted"
                style={{ marginTop: space.xs }}
              >
                {`${template.exerciseCount} 个动作${
                  template.id === plannedId ? ' · 已选' : ''
                }`}
              </Text>
            </Pressable>
          ))}

          <Button label="去编排计划" variant="ghost" onPress={openPlanList} />
        </View>
      </View>
    </Modal>
  );

  return (
    <Screen>
      <View style={{ paddingTop: space.xl, paddingBottom: space.lg }}>
        <Text variant="h1">训练</Text>
      </View>

      {/* 主次关系全在这一段：有未结束的训练时它排在前面、用主按钮 */}
      <View style={{ gap: space.lg }}>
        {current ? (
          <Card highlighted>
            <Text variant="label" color="textMuted">
              进行中
            </Text>
            <Text
              variant="h2"
              style={{ marginTop: space.xs, marginBottom: space.xs }}
            >
              {formatDateTime(current.startedAt)}
            </Text>
            <Button
              label="继续训练"
              detail={describeExercises(exercises)}
              onPress={() => openSession(current.id)}
              style={{ marginTop: space.sm }}
            />
          </Card>
        ) : null}

        {/* 今天该练的那套计划。只在没有进行中的训练时出现 —— 用户在健身房掏出
            手机的那一刻要的是回到刚才那场，任何新东西都不许挤到「继续训练」前面 */}
        {!current && plannedId ? (
          <Card>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text variant="label" color="textMuted">
                今天该练
              </Text>
              {/* 「第 2 / 3 套」：没有它的话用户看不出这是循环的哪一环，也不知道
                  再练几场会转回来 —— 而这正是「分化循环」这个概念本身 */}
              <Text variant="label" color="textFaint">
                {`第 ${templates.findIndex((t) => t.id === plannedId) + 1} / ${
                  templates.length
                } 套`}
              </Text>
            </View>

            <Text variant="h2" style={{ marginTop: space.xs }}>
              {templates.find((t) => t.id === plannedId)?.name ?? '计划'}
            </Text>

            {/* 动作说明在这张卡片上必须手写，不能复用 `describeExercises`：那个
                函数是给「进行中的训练」用的，它读的是组（`sets`）并拼出
                「· 已记 N 组」，而计划里只有动作名、根本没有组 —— 传进去会读到
                `undefined.isCompleted` 直接抛错。这里只报数 + 头一个动作名 */}
            <Text
              variant="caption"
              color="textMuted"
              style={{ marginTop: space.xs }}
            >
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

        <Button
          label={current ? '开始新训练' : '开始训练'}
          variant={current ? 'secondary' : 'primary'}
          onPress={handleStart}
          loading={loading}
        />

        {!current ? (
          <Text variant="caption" color="textMuted" style={{ textAlign: 'center' }}>
            会沿用上次的动作清单，直接接着练
          </Text>
        ) : null}
      </View>

      {pickerModal}
    </Screen>
  );
}
