import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DragNumber } from '../../src/components/DragNumber';
import { RestTimer } from '../../src/components/RestTimer';
import { Stepper } from '../../src/components/Stepper';
import type { Exercise, SetEntry } from '../../src/domain/types';
import { useDatabase } from '../../src/repositories/database';
import { listExercises } from '../../src/repositories/exerciseRepo';
import { getLastPerformance } from '../../src/repositories/setRepo';
import { useActiveSession } from '../../src/store/activeSession';

/** 肌群为空的自定义动作归到这一组，避免列表里出现没有标题的一段 */
const UNGROUPED_LABEL = '其他';

interface ExerciseGroup {
  title: string;
  data: Exercise[];
}

/**
 * 按肌群分组，组内保持 `listExercises` 给的顺序。
 *
 * `listExercises` 已经按「肌群顺序 + 拼音」排好了（排序逻辑在仓储层，
 * 界面不重排），所以这里只做相邻归并，不排序、不重排。
 *
 * @param exercises `listExercises` 的返回，顺序必须是它排好的那个顺序 ——
 *   这个函数只在相邻两项之间归并，顺序一乱就会把同一个肌群切成好几段，
 *   弹层里会出现一排重复的标题
 * @returns 分段数据，每段自带标题；肌群为空的自定义动作会落在「其他」那一段里，
 *   所以基本不会出现没有标题的一段
 */
function groupByMuscleGroup(exercises: Exercise[]): ExerciseGroup[] {
  const groups: ExerciseGroup[] = [];
  for (const exercise of exercises) {
    const title = exercise.muscleGroup ?? UNGROUPED_LABEL;
    const last = groups[groups.length - 1];
    if (last && last.title === title) {
      last.data.push(exercise);
    } else {
      groups.push({ title, data: [exercise] });
    }
  }
  return groups;
}

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
  // 让出状态栏，所以必须自己把内容压到状态栏下面 —— 否则顶部动作条会和
  // 信号、时钟、运营商文字叠在一起。
  const insets = useSafeAreaInsets();

  const {
    session,
    exercises,
    currentIndex,
    resume,
    addExercise,
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
  // 搜索框里的原始输入（未 trim）。空串即不过滤，全库平铺
  const [query, setQuery] = useState('');
  // 动作库全表，只在弹层打开时读一次（见下面那个读它的 effect）
  const [allExercises, setAllExercises] = useState<Exercise[]>([]);

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

  // 动作清单只在弹层打开时读一次：训练过程中库里不会新增动作，
  // 每次开弹层都全表重读纯属浪费。
  useEffect(() => {
    if (!pickerVisible) return;
    let cancelled = false;
    (async () => {
      const all = await listExercises(exec);
      if (!cancelled) setAllExercises(all);
    })();
    return () => {
      cancelled = true;
    };
  }, [exec, pickerVisible]);

  // 过滤按「包含」而不是「前缀」：动作名多是「杠铃卧推」这类词组，用户更可能
  // 只记得中间那两个字。先 trim 再比，否则结尾多打一个空格结果就全空了
  const trimmedQuery = query.trim();
  // 过滤 + 分组每敲一个字重算一次。动作库是几十条的量级，这个代价比维护一份
  // 增量索引小得多，也更不容易出错
  const visibleGroups = useMemo(() => {
    const matched = trimmedQuery
      ? allExercises.filter((e) => e.name.includes(trimmedQuery))
      : allExercises;
    return groupByMuscleGroup(matched);
  }, [allExercises, trimmedQuery]);

  /**
   * 打开动作选择弹层。顺手清空搜索词：留着上一次的残留，用户看到的会是一份
   * 莫名其妙变短的列表，而搜索框里那几个字在小屏上未必一眼看得见。
   *
   * @returns 无返回值
   */
  const openPicker = () => {
    setQuery('');
    setPickerVisible(true);
  };

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
    <Modal
      visible={pickerVisible}
      transparent
      animationType="slide"
      // Android 的物理返回键 / 手势返回：不接这个回调，返回键会直接退出整屏。
      onRequestClose={closePicker}
    >
      <View style={styles.modalRoot}>
        <Pressable style={styles.modalBackdrop} onPress={closePicker} />
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>选择动作</Text>
            <Pressable
              style={styles.sheetCancel}
              onPress={closePicker}
              accessibilityLabel="取消"
            >
              <Text style={styles.sheetCancelText}>取消</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="搜索动作名称"
            placeholderTextColor="#a8adb5"
            returnKeyType="search"
            autoCorrect={false}
          />

          <FlatList
            data={visibleGroups}
            keyExtractor={(group) => group.title}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item: group }) => (
              <View>
                <Text style={styles.groupTitle}>{group.title}</Text>
                {group.data.map((exercise) => (
                  <Pressable
                    key={exercise.id}
                    style={styles.option}
                    onPress={() => {
                      void handlePickExercise(exercise);
                    }}
                  >
                    <Text style={styles.optionText}>{exercise.name}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            ListEmptyComponent={
              <Text style={styles.emptyHint}>
                {allExercises.length === 0
                  ? '动作库是空的'
                  : `没有找到「${trimmedQuery}」`}
              </Text>
            }
          />
        </View>
      </View>
    </Modal>
  );

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

  // 空状态：这场训练一个动作都没有（第一次用 App，没有上一次训练可以复制）。
  // 除了提示文案，必须给一个显眼的添加入口 —— 否则用户在这一屏无路可走。
  // 和记录界面一样自己让出状态栏：这个路由是 headerShown: false。
  if (!current) {
    return (
      <View
        style={[
          styles.container,
          styles.emptyContainer,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 20 },
        ]}
      >
        <Text style={styles.hint}>这次训练还没有动作</Text>
        <Text style={styles.emptyTip}>添加一个动作就可以开始记录了</Text>
        <Pressable
          style={styles.completeButton}
          onPress={openPicker}
          accessibilityLabel="添加动作"
        >
          <Text style={styles.completeButtonText}>＋　添加动作</Text>
        </Pressable>
        {pickerModal}
      </View>
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
      <View
        style={[
          styles.container,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 20 },
        ]}
      >
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
      </View>
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
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <View style={styles.chipBarWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipBar}
        >
          {exercises.map((item, index) => {
            const active = index === currentIndex;
            return (
              <Pressable
                key={item.sessionExercise.id}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setCurrentIndex(index)}
                accessibilityState={{ selected: active }}
              >
                <Text
                  style={[styles.chipText, active && styles.chipTextActive]}
                  numberOfLines={1}
                >
                  {item.exerciseName}
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            style={[styles.chip, styles.chipAdd]}
            onPress={openPicker}
            accessibilityLabel="添加动作"
          >
            <Text style={styles.chipAddText}>＋</Text>
          </Pressable>
        </ScrollView>
      </View>

      <View style={styles.setRow}>
        <Text style={styles.setNumber}>第 {setNumber} 组</Text>
        {setNumber <= plannedSets ? (
          <Text style={styles.setPlanned}>共 {plannedSets} 组</Text>
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

      <Text style={styles.dragHint}>← 左右拖动数字调整 →</Text>

      {lastSamePosition ? (
        <Text style={styles.lastHint}>
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

      <Pressable style={styles.completeButton} onPress={handleComplete}>
        <Text style={styles.completeButtonText}>✓　完成这组</Text>
      </Pressable>

      <Pressable style={styles.finishButton} onPress={handleFinish}>
        <Text style={styles.finishButtonText}>结束训练</Text>
      </Pressable>

      {/* 与空状态共用同一个弹层实例定义 */}
      {pickerModal}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20, gap: 10, backgroundColor: '#fff' },
  hint: { textAlign: 'center', color: '#8a8f98', marginTop: 40 },

  // 空状态：内容整体居中，「添加动作」按钮做成整宽的实心主按钮 —— 这一屏
  // 只有这一个出口，它必须一眼可见、单手够得着。
  emptyContainer: { justifyContent: 'center' },
  emptyTip: { textAlign: 'center', color: '#a8adb5', fontSize: 13 },

  // 顶部动作条：横向滚动，当前动作高亮
  chipBarWrapper: { marginHorizontal: -16 },
  chipBar: { paddingHorizontal: 16, gap: 8, alignItems: 'center' },
  chip: {
    maxWidth: 180,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#eceef2',
  },
  chipActive: { backgroundColor: '#2b7fff' },
  chipText: { fontSize: 14, fontWeight: '600', color: '#4b5058' },
  chipTextActive: { color: '#fff' },
  chipAdd: { paddingHorizontal: 16 },
  chipAddText: { fontSize: 16, fontWeight: '800', color: '#4b5058' },

  // 组数：整屏第二重要的信息，只排在数值后面
  setRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 8 },
  setNumber: { fontSize: 28, fontWeight: '800' },
  setPlanned: { fontSize: 13, color: '#8a8f98' },

  bigRow: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  bigTimes: { fontSize: 24, color: '#8a8f98', marginHorizontal: 4 },
  dragHint: { fontSize: 12, color: '#a8adb5', textAlign: 'center' },
  lastHint: { fontSize: 13, color: '#8a8f98', textAlign: 'center' },

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

  // 动作选择弹层
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  // 不用 `StyleSheet.absoluteFillObject`：这一版 react-native 的类型里已经
  // 没有这个导出了（只剩 `absoluteFill`），直接写全 absolute 四边更省事。
  modalBackdrop: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    maxHeight: '80%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 12,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { fontSize: 18, fontWeight: '700' },
  sheetCancel: { paddingHorizontal: 8, paddingVertical: 4 },
  sheetCancelText: { fontSize: 15, color: '#2b7fff', fontWeight: '600' },
  search: {
    backgroundColor: '#f3f4f7',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
  },
  groupTitle: { fontSize: 12, color: '#8a8f98', marginTop: 12, marginBottom: 4 },
  option: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eceef2' },
  optionText: { fontSize: 16 },
  emptyHint: { textAlign: 'center', color: '#8a8f98', paddingVertical: 24 },
});
