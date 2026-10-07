import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { DragNumber } from '../../src/components/DragNumber';
import { ExercisePickerModal } from '../../src/components/ExercisePickerModal';
import { RestTimer } from '../../src/components/RestTimer';
import { Stepper } from '../../src/components/Stepper';
import type { Exercise, SetEntry } from '../../src/domain/types';
import { useDatabase } from '../../src/repositories/database';
import { getLastPerformance } from '../../src/repositories/setRepo';
import { useActiveSession } from '../../src/store/activeSession';
import {
  Button,
  Pill,
  Screen,
  Text,
  fontSize,
  radius,
  space,
  tracking,
  usePalette,
  weight,
} from '../../src/ui';

/**
 * 核心记录界面：一次只聚焦「当前这一组」。
 *
 * 设计要点：整屏只有一条动作条、一组大数字和一个主按钮。用户在健身房
 * 单手、喘着气、屏幕可能被汗糊住，任何需要「找」的交互都是失败设计。
 *
 * 调数值有两条路，各有各的适用场景：
 * - **左右拖大数字**：一档 2.5 kg / 1 次，适合「从 20 加到 60」这种大跨度调整；
 * - **大数字下方的小 +/−**：精确微调。手上有汗时纯拖动容易滑过头，必须留一条退路。
 *
 * 数据流全部经过 store 与仓储层：`completeCurrentSet` 会先把用户填的数值写库、
 * 再标记完成、再开始休息计时、并预建下一组 —— 也就是「完成即落盘」，中途杀掉
 * App 也不会丢已经做完的组。
 *
 * 路由参数 `id` 是 workout_session.id。从训练页跳进来时 store 里已经有这一场，
 * 深链直接打开时 store 是空的，下面的 effect 会自己去库里把未结束的那场捞回来。
 *
 * @returns 四种界面之一，而且判断顺序不能调：休息计时屏 → 记录界面 →
 *   「这次训练还没有动作」→「不存在或已结束」。每一道都在代码里写明了它为什么
 *   必须排在前面
 */
export default function SessionScreen() {
  const exec = useDatabase();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // 这个路由在 app/_layout.tsx 里设了 headerShown: false，导航栏不再替我们
  // 让出状态栏，所以下面的 `Screen` 会自动补上顶部内边距 —— 否则顶部动作条会和
  // 信号、时钟、运营商文字叠在一起。

  // 绑定了当前主题的样式。必须在这一屏的顶层调用一次，四个早返回分支共用它
  const styles = useSessionStyles();

  const {
    session,
    exercises,
    currentIndex,
    resume,
    addExercise,
    removeExercise,
    setCurrentIndex,
    completeCurrentSet,
    beginNextSet,
    endWorkout,
  } = useActiveSession();

  // 这一组待填的数值。注意它**不是**已经记下的数 —— 点「完成这组」时才写库。
  // 初值 20/8 只是兜底，真正该显示什么由下面那个预填 effect 决定
  const [weight, setWeight] = useState(20);
  const [reps, setReps] = useState(8);
  // 「上次练这个动作」的那几组，用来提示「上次第 2 组：60 kg × 8」，
  // 也用来推算这次打算练几组
  const [lastPerformance, setLastPerformance] = useState<SetEntry[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);

  // 收尾中：`endWorkout` 会立刻清空 store，而 `router.replace` 还在后面。
  // 不挡住这一帧的话，屏幕上会闪过一句「这场训练不存在或已结束」。
  const [finishing, setFinishing] = useState(false);
  // 深链进来时 store 可能是空的，得先知道「加载中」和「确实没有」的区别 ——
  // 只判 `!session` 的话，一个不存在的 id 会让这一屏永远停在「载入中…」。
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing'>(
    'loading',
  );

  // 从训练页跳进来时 store 里已经有 session；但如果 App 被强杀后用深链直接
  // 打开这个路由，store 是空的，得自己把库里的未结束训练捡回来。
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

  // 当前聚焦的动作。`currentIndex` 归 store 管，点顶部动作条上任何一个 chip
  // 或者 `addExercise` 都会改它
  const current = exercises[currentIndex];
  // 当前动作的组。`?? []` 不是防御性编程意义上的兜底 —— 空状态（这场还没有动作）
  // 会走到下面分支，这里先给出空数组，`current` 为 undefined 时下面几处
  // `.find()` 才不用层层判空
  const currentSets = current?.sets ?? [];
  // 当前该记的那一组：本动作里第一条还没完成的记录。它同时决定「第几组」的编号
  // 和「完成这组」写进哪条记录 —— 找不到它 `completeCurrentSet` 会直接 return，
  // 所以「加动作时预建第一组 / 完成时预建下一组」是硬需求
  const pending: SetEntry | undefined = useMemo(
    () => currentSets.find((s) => !s.isCompleted),
    [currentSets],
  );

  // 休息态：当前动作里存在「已完成、且休息还没结束」的那一组。
  // `restStartedAt` 由 `startRest` 写下、由 `endRest` 清空，所以这个判定
  // 是「库里的事实」，不是本屏的临时 state —— 杀掉 App 重进也照样落在休息屏。
  const restingSet: SetEntry | undefined = useMemo(
    () => currentSets.find((s) => s.isCompleted && s.restStartedAt !== null),
    [currentSets],
  );

  // 换动作时必须重新预填。光靠 `pending?.id` 是不够的：两个动作各自
  // 「还没做的那一组」是不同记录，但切回一个只做过一组的动作时也可能撞上
  // 同一个 id，那时 effect 不重跑，屏幕上留的就是上一个动作的数值。
  // 所以额外记住上一次预填的 sessionExercise.id，用来判断「换动作了没有」。
  const lastExerciseIdRef = useRef<string | null>(null);
  const lastPendingIdRef = useRef<string | null>(null);

  // 预填：优先沿用上一组刚做完的数值（同一动作内重量通常不变），
  // 没有上一组时才退回这一组自己在库里的默认值。
  useEffect(() => {
    if (!pending) return;
    const sessionExerciseId = current?.sessionExercise.id ?? null;
    const switchedExercise = sessionExerciseId !== lastExerciseIdRef.current;
    if (!switchedExercise && pending.id === lastPendingIdRef.current) return;
    lastExerciseIdRef.current = sessionExerciseId;
    lastPendingIdRef.current = pending.id;
    const previousDone = [...currentSets].reverse().find((s) => s.isCompleted);
    setWeight(previousDone?.weight ?? pending.weight);
    setReps(previousDone?.reps ?? pending.reps);
  }, [current?.sessionExercise.id, pending?.id, currentSets]);

  // 「上次第 N 组：X kg × Y」提示。第三个参数必须是**当前** session id，
  // 仓储层用它把当前这场训练排除掉，否则会拿今天的记录当「上次」。
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

  /**
   * 打开动作选择弹层。搜索词由弹层自己在打开时清空（见 `ExercisePickerModal`）——
   * 搜索框是它自己管的 state，清空这件事只能由它做，否则下次打开会留着上一次的残留。
   *
   * @returns 无返回值
   */
  const openPicker = () => setPickerVisible(true);

  /**
   * 关掉弹层。选完动作、点取消、点背景、按 Android 返回键，四条路都汇到这里。
   *
   * @returns 无返回值
   */
  const closePicker = () => setPickerVisible(false);

  /**
   * 选中一个动作：把它加进这场训练。
   *
   * 加失败时**不关弹层**。用户挑的动作没进去，关掉弹层只会让他以为加上了，
   * 对着同一屏反复点；Alert 说明原因后把弹层留着，他可以直接重挑一个。
   *
   * @param exercise 用户点的那一项，来自动作库的 `exercise` —— 不是这一场里
   *   已经存在的 sessionExercise
   * @returns 无返回值；成功时关闭弹层，失败时保持打开
   */
  const handlePickExercise = async (exercise: Exercise) => {
    try {
      // store 的 addExercise 会自动把 currentIndex 切到新动作，
      // 并预建第一组（沿用上次练这个动作的重量/次数）。
      await addExercise(exec, exercise.id);
    } catch (e) {
      Alert.alert(
        '没能加上这个动作',
        e instanceof Error ? e.message : String(e),
      );
      return;
    }
    setPickerVisible(false);
  };

  // 动作选择弹层抽成变量，供两个分支复用：正常的记录界面，以及下面那个
  // 「这场训练还没有动作」的空状态。
  //
  // 空状态必须能打开它：新用户开的第一场训练是空的（没有上一次训练可以复制），
  // 如果这里只留一句话，屏幕上就没有任何添加入口 —— 用户会彻底卡死在这一屏，
  // 既记不了组，也不知道该往哪点。复用同一个弹层而不是另写一套，是为了让
  // 「选动作」永远只有一份实现。
  const pickerModal = (
    <ExercisePickerModal
      visible={pickerVisible}
      onClose={closePicker}
      onPick={(exercise) => {
        void handlePickExercise(exercise);
      }}
    />
  );

  if (finishing) {
    // 一帧的空白，紧接着就是总结页
    return <View style={styles.container} />;
  }

  // 下面三个分支共用同一个外壳：主题背景 + 状态栏 + 安全区都由 `Screen` 负责，
  // 这里只描述内容。三处原本各写一遍内边距算式，少写一处就会顶进状态栏。
  if (!session || session.id !== id) {
    return (
      <Screen style={styles.emptyContainer}>
        <Text variant="title" color="textMuted" style={{ textAlign: 'center' }}>
          {loadState === 'loading' ? '载入中…' : '这场训练不存在或已结束'}
        </Text>
        {loadState === 'missing' ? (
          <Button
            label="回主页"
            onPress={() => router.replace('/(tabs)')}
            fullWidth={false}
          />
        ) : null}
      </Screen>
    );
  }

  // 写保护：这场已经结束了，就不该再渲染记录界面。
  // 深链（或从总结页按系统返回键绕回来）能走到这里，而「结束」必须不可逆 ——
  // 之前同一场训练被接上第二次、第三次，靠的就是这里没有这道判断。
  if (session.finishedAt !== null) {
    return (
      <Screen style={styles.emptyContainer}>
        <Text variant="title" color="textMuted" style={{ textAlign: 'center' }}>
          这场训练已经结束
        </Text>
        <Button
          label="回主页"
          onPress={() => router.replace('/(tabs)')}
          fullWidth={false}
        />
      </Screen>
    );
  }

  // 空状态：这场训练一个动作都没有（第一次用 App，没有上一次训练可以复制）。
  // 除了提示文案，必须给一个显眼的添加入口 —— 否则用户在这一屏无路可走。
  // 和记录界面一样自己让出状态栏：这个路由是 headerShown: false。
  if (!current) {
    return (
      <Screen style={styles.emptyContainer}>
        <Text variant="title" color="textMuted" style={{ textAlign: 'center' }}>
          这次训练还没有动作
        </Text>
        <Text variant="caption" color="textFaint" style={{ textAlign: 'center' }}>
          添加一个动作就可以开始记录了
        </Text>
        <Button label="＋　添加动作" onPress={openPicker} accessibilityLabel="添加动作" />
        {pickerModal}
      </Screen>
    );
  }

  // 休息态必须放在记录界面之前返回：休息时整屏只该有一个大计时和两个按钮，
  // 把重量/次数/完成按钮留在屏幕上只会诱导用户「休息时又点一次完成」。
  if (restingSet && restingSet.restStartedAt !== null) {
    const startedAt = restingSet.restStartedAt;

    // 「换下一个动作」只有真的还有下一个动作时才切；没有就退化成开始下一组。
    // 两条路径都先 `beginNextSet` 把当前这段休息结掉（写入 rest_seconds），
    // 否则计时会一直悬着，这一段休息的时长永远不会落库。
    /**
     * 结束这段休息，然后（真的还有下一个动作时才）切过去。
     *
     * 结束休息失败就直接返回、不切动作：计时还悬着的时候跳走，这一段休息的
     * 时长同样落不了库，而且用户会以为休息已经记完了。
     *
     * @returns 无返回值；当前已经是最后一个动作时停在原地，等价于「开始下一组」
     */
    const handleSwitchExercise = async () => {
      try {
        await beginNextSet(exec);
      } catch (e) {
        Alert.alert('没能结束这段休息', e instanceof Error ? e.message : String(e));
        return;
      }
      const hasNext = currentIndex + 1 < exercises.length;
      if (hasNext) setCurrentIndex(currentIndex + 1);
    };

    return (
      // 顶部同样让出状态栏：这个路由是 headerShown: false，没有导航栏帮忙。
      <Screen style={styles.container}>
        <RestTimer
          startedAt={startedAt}
          justCompleted={{ weight: restingSet.weight, reps: restingSet.reps }}
          onStartNextSet={() => {
            void beginNextSet(exec);
          }}
          onSwitchExercise={() => {
            void handleSwitchExercise();
          }}
        />
      </Screen>
    );
  }

  // 下面几行都是现算的派生值，不另存 state：存了就要处处维护它和组同步，
  // 而这点计算本身是零成本的
  const completedCount = currentSets.filter((s) => s.isCompleted).length;
  // 组号从 1 开始，所以是「已完成数 + 1」
  const setNumber = completedCount + 1;
  // 计划组数：上次练这个动作做几组就按几组显示；没有历史时给 3 组这个常见默认值，
  // 用了 `||` 所以 0 也算没有
  const plannedSets = lastPerformance.length || 3;
  // 「上次第 N 组」的数据源，按序号对齐（这次的第 2 组比上次的第 2 组）
  const lastSamePosition = lastPerformance[completedCount];

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

  /**
   * 「完成这组」：把当前填的数值写库、标记完成、开始休息计时、预建下一组 ——
   * 四件事都在 store 的 `completeCurrentSet` 里一次做完（也就「完成即落盘」）。
   *
   * 写库失败必须弹窗并 return：这是落盘的唯一入口，静默失败会让用户以为这一组
   * 已经记下了。Alert 不阻断后续操作，他可以直接再点一次。
   *
   * @returns 无返回值；成功后补一发轻振动作为「记下了」的即时反馈，
   *   没有振动马达的设备上忽略
   */
  const handleComplete = async () => {
    try {
      await completeCurrentSet(exec, weight, reps);
    } catch (e) {
      // 这一步是「完成即落盘」的唯一入口，写库失败必须让用户知道，
      // 否则他会以为这一组已经记下了。Alert 不阻断下一组的操作。
      Alert.alert('这一组没能存进数据库', e instanceof Error ? e.message : String(e));
      return;
    }
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      // 无振动马达的设备上忽略
    }
  };

  // 误触「结束训练」会让人以为记录丢了，必须二次确认。
  // 无论用户选哪一项，已完成的组早就落盘了，不会丢。
  //
  // 确认后先 `endWorkout`（结束进行中的休息、写 finished_at），再进总结页 ——
  // 总结页要按 finished_at 算时长，不能等用户在总结页点保存时才写。
  // 必须用对象形式导航：expo-router 的 typedRoutes 只生成
  // `/session/summary/[id]` 这个字面量，模板字符串过不了 tsc。
  /**
   * 「结束训练」：二次确认 → 写 finished_at → 换成总结页。
   *
   * 用 `replace` 而不是 `push`：结束过的训练不该留在返回栈里被退回来，
   * 记录界面顶部那道「已结束」判断只是走深链进来时的兜底。
   *
   * @returns 无返回值。Alert 是异步的，这个函数立刻返回，不等用户点完；
   *   真正的收尾在确认按钮的回调里
   */
  const handleFinish = () => {
    Alert.alert('结束这次训练？', '已经记录的组都会保留。', [
      { text: '继续练', style: 'cancel' },
      {
        text: '结束',
        style: 'destructive',
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
      },
    ]);
  };

  return (
    <Screen style={styles.container}>
      <View style={styles.chipBarWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipBar}
        >
          {exercises.map((item, index) => (
            <Pill
              key={item.sessionExercise.id}
              label={item.exerciseName}
              selected={index === currentIndex}
              onPress={() => setCurrentIndex(index)}
            />
          ))}
          {/* 「加动作」做成同样大小的药丸：它和动作名是同一类东西（这一场里
              有哪些动作），排在一起才读得懂 */}
          <Pill label="＋" onPress={openPicker} accessibilityLabel="添加动作" />
        </ScrollView>
      </View>

      {exercises.length > 1 ? (
        <Pressable
          onPress={handleRemoveExercise}
          accessibilityRole="button"
          accessibilityLabel={`删除动作：${current?.exerciseName ?? ''}`}
          // 这一行视觉上只有一行小字（约 25dp 高），远低于 48dp 的可点建议值。
          // 而它出现的场合恰恰是最不能要求精确点击的：健身房、单手、手上有汗。
          // `hitSlop` 把热区撑到 48dp 而**不改变视觉** —— 这一行必须看起来不起眼
          // （它和「结束训练」同属低频且误触代价高的一类，不该跟主按钮抢注意力），
          // 但按起来不能费劲。这两个要求只能靠 hitSlop 同时满足。
          hitSlop={{ top: 12, bottom: 12, left: 24, right: 24 }}
          style={styles.removeRow}
        >
          <Text variant="caption" style={styles.removeText}>
            删除「{current?.exerciseName}」
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.setRow}>
        <Text variant="numeric" style={styles.setNumber}>
          第 {setNumber} 组
        </Text>
        {setNumber <= plannedSets ? (
          <Text variant="caption" style={styles.setPlanned}>
            共 {plannedSets} 组
          </Text>
        ) : null}
      </View>

      <View style={styles.bigRow}>
        <DragNumber
          label="重量"
          unit="kg"
          value={weight}
          step={2.5}
          min={0}
          onChange={setWeight}
        />
        <Text style={styles.bigTimes}>×</Text>
        <DragNumber label="次数" value={reps} step={1} min={1} onChange={setReps} />
      </View>

      <Text variant="label" style={styles.dragHint}>
        ← 左右拖动数字调整 →
      </Text>

      {lastSamePosition ? (
        <Text variant="caption" style={styles.lastHint}>
          上次第 {completedCount + 1} 组：{lastSamePosition.weight} kg ×{' '}
          {lastSamePosition.reps}
        </Text>
      ) : null}

      <View style={styles.steppers}>
        <Stepper
          label="重量"
          value={weight}
          step={2.5}
          min={0}
          onChange={setWeight}
        />
        <Stepper label="次数" value={reps} step={1} min={1} onChange={setReps} />
      </View>

      <Button label="✓　完成这组" onPress={handleComplete} />

      {/* 「结束训练」用 ghost：它低频、且误触代价高，不该和主按钮抢注意力 */}
      <Button label="结束训练" variant="ghost" onPress={handleFinish} />

      {/* 与空状态共用同一个弹层实例定义 */}
      {pickerModal}
    </Screen>
  );
}

/**
 * 这一屏用到的全部样式。
 *
 * **写成 hook 而不是模块级的 `StyleSheet.create`**：颜色现在来自主题，而主题在
 * 运行时才定（跟随系统明暗）。模块级常量在模块加载时就固化了，拿不到主题。
 *
 * 布局类样式（间距、方向、对齐）走 `src/ui` 的 token；只有颜色取自 palette。
 * 这样「间距用 4 的倍数、颜色只有主题里有」两条规则在这一屏也成立。
 *
 * @returns 绑定了当前主题的样式对象
 */
function useSessionStyles() {
  const palette = usePalette();

  return useMemo(
    () => ({
      container: {
        flex: 1,
        backgroundColor: palette.bg,
        paddingHorizontal: space.lg,
        paddingBottom: space.xl,
        gap: space.sm,
      },
      // 空状态：内容整体居中，「添加动作」按钮整宽实心 —— 这一屏只有这一个
      // 出口，它必须一眼可见、单手够得着。
      emptyContainer: { justifyContent: 'center' as const, gap: space.md },

      // 顶部动作条：横向滚动，当前动作高亮
      chipBarWrapper: { marginHorizontal: -space.lg },
      chipBar: {
        paddingHorizontal: space.lg,
        gap: space.sm,
        alignItems: 'center' as const,
      },

      // 「删除这个动作」：低频、代价高，所以做成一行小字而不是按钮。
      // 它和下面的「结束训练」一样属于「别乱点」的那一类，不跟主按钮抢注意力。
      //
      // `paddingVertical: space.md`（12dp）不是随手写的：13px 的字 + 上下各 12dp
      // ≈ 44dp，正好够到可点热区的下限。只有 4dp 的话整行才 25dp 高，而这一屏是
      // 单手、手上有汗的时候用的 —— 那里点不中等于这个功能不存在。
      // 视觉上仍然是一行不起眼的小字，靠的是字号和颜色，不是靠把热区做小。
      removeRow: { alignSelf: 'center' as const, paddingVertical: space.md },
      removeText: { color: palette.danger, textDecorationLine: 'underline' as const },

      // 组数：整屏第二重要的信息，只排在数值后面
      setRow: {
        flexDirection: 'row' as const,
        alignItems: 'baseline' as const,
        justifyContent: 'center' as const,
        gap: space.sm,
      },
      setNumber: { fontSize: fontSize.h2, fontWeight: weight.bold },
      setPlanned: { fontSize: fontSize.caption, color: palette.textMuted },

      // 大数字那一行。凹面色块把它和周围的正文分开，形成「仪表读数区」
      bigRow: {
        flex: 1,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        marginVertical: space.xs,
        borderRadius: radius.lg,
        backgroundColor: palette.surfaceSunken,
      },
      bigTimes: {
        fontSize: fontSize.h2,
        color: palette.textFaint,
        marginHorizontal: space.xs,
      },
      dragHint: {
        fontSize: fontSize.label,
        color: palette.textFaint,
        textAlign: 'center' as const,
        letterSpacing: tracking.label,
      },
      lastHint: {
        fontSize: fontSize.caption,
        color: palette.textMuted,
        textAlign: 'center' as const,
      },

      steppers: {
        flexDirection: 'row' as const,
        justifyContent: 'space-around' as const,
      },
    }),
    [palette],
  );
}
