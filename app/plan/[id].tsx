import {
  Stack,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Modal,
  Pressable,
  TextInput,
  View,
} from 'react-native';

import type { Exercise } from '../../src/domain/types';
import { useDatabase } from '../../src/repositories/database';
import { listExercises } from '../../src/repositories/exerciseRepo';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  renameTemplate,
  setTemplateExercises,
} from '../../src/repositories/templateRepo';
import {
  Button,
  Screen,
  Text,
  border,
  fontSize,
  radius,
  space,
  tracking,
  usePalette,
  weight,
} from '../../src/ui';

/** 新建计划时的默认名。名字被清空时也退回它 —— 一个没有名字的计划只是一行空白 */
const DEFAULT_PLAN_NAME = '新计划';

/** 肌群为空的自定义动作归到这一组，避免列表里出现没有标题的一段 */
const UNGROUPED_LABEL = '其他';

interface ExerciseGroup {
  title: string;
  data: Exercise[];
}

/**
 * 按肌群分组，组内保持 `listExercises` 给的顺序。
 *
 * `listExercises` 已经按「肌群顺序 + 拼音」排好了（排序逻辑在仓储层，界面不重排），
 * 所以这里只做相邻归并，不排序、不重排。
 *
 * @param exercises `listExercises` 的返回，顺序必须是它排好的那个顺序 ——
 *   这个函数只在相邻两项之间归并，顺序一乱就会把同一个肌群切成好几段，
 *   弹层里会出现一排重复的标题
 * @returns 分段数据，每段自带标题
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
 * 把一个元素从 `from` 挪到 `to`，返回新数组。
 *
 * 动作清单只有「整体覆盖」一个写入口（`setTemplateExercises`），所以这份本地
 * 副本就是编辑期间唯一的事实来源：上移、下移、删除、添加都只动它，点「保存」
 * 才整体写回去。
 *
 * @param list 原数组（不会被修改）
 * @param from 原下标
 * @param to 目标下标；越界时原样返回
 * @returns 挪过之后的新数组
 */
function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * 计划编辑页：本地改一份副本，点「保存」才整体写库。
 *
 * 两个生命周期上的设计：
 *
 * 1. **从 `id === 'new'` 进来时先建一个空计划**，再 `router.setParams` 把路由参数
 *    换成真实 id。这样「加动作」的写入路径只有一条（都是写一个已存在的计划），
 *    不必为「还没保存的计划」另准备一套暂存逻辑。
 * 2. 代价是库里会多出一个空计划，所以返回时要清理：**只有本次新建、且名字没改过、
 *    一个动作都没有**的那一个才删（`isNewPlanRef`）。打开一个本来就叫「新计划」的旧
 *    计划不会误删 —— 它不是本次新建的。
 *
 * 有未保存改动时按返回键（Android 的物理返回键 / 导航栏左上角 / 手势）弹
 * 「放弃修改？」—— 见下面那两个 effect。
 *
 * @returns 编辑界面；正在新建时是转圈，计划不存在时是一句提示加返回按钮
 */
export default function PlanEditScreen() {
  const exec = useDatabase();
  const router = useRouter();
  const navigation = useNavigation();
  const { id } = useLocalSearchParams<{ id: string }>();

  // 绑定了当前主题的样式。必须在这一屏的顶层调用一次，所有分支共用它
  const styles = usePlanEditStyles();
  // 弹层里搜索框的占位文字色也要跟主题走
  const palette = usePalette();

  // 本地可编辑副本：名字 + 动作 id 数组，**数组顺序就是计划里的顺序**
  const [name, setName] = useState(DEFAULT_PLAN_NAME);
  const [exerciseIds, setExerciseIds] = useState<string[]>([]);
  // 只为了显示：id → 动作名。计划里的动作全部来自 `getTemplate`（带名字），
  // 新加的动作在添加时把名字塞进来，所以编辑期间不必再查库
  const [names, setNames] = useState<Record<string, string>>({});

  // 取过一次数才置真。没有它就无法区分「还在查」和「这个计划不存在」
  const [loaded, setLoaded] = useState(false);
  // 库里查到了这个计划。**不能拿「动作清单是空的」当「计划不存在」** ——
  // 一个刚建出来、还没加动作的计划本来就没有动作
  const [found, setFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 加动作的弹层
  const [pickerVisible, setPickerVisible] = useState(false);
  // 搜索框里的原始输入（未 trim）。空串即不过滤，全库平铺
  const [query, setQuery] = useState('');
  // 动作库全表，只在弹层打开时读一次
  const [allExercises, setAllExercises] = useState<Exercise[]>([]);

  // 正在保存：挡住重复提交
  const [saving, setSaving] = useState(false);
  // 这次返回是在清理「本次新建、什么都没改」的空计划
  const [deleting, setDeleting] = useState(false);

  // 本次新建的计划 id（`id === 'new'` 分支才有值）；也是「这是本次新建」这个
  // 判断的唯一依据 —— 用它才不会把用户原本就叫「新计划」的旧计划删掉
  const newPlanIdRef = useRef<string | null>(null);
  // 防止 StrictMode 下 effect 跑两遍时建出两个空计划
  const createStartedRef = useRef(false);
  // 进入时的快照。和它逐项比对就能算出「有没有未保存的改动」，
  // 不必再维护一个到处要记得置真的 dirty 标志
  const initialRef = useRef<{ name: string; exerciseIds: string[] } | null>(null);
  // 异步回写的兜底开关
  const mountedRef = useRef(true);
  // 这三个是给 `beforeRemove` 监听器读的**同步**标记：state 要等一次重渲染才生效，
  // 挡不住同一帧里紧接着发生的那次返回。监听器用 ref 而不是把它们放进依赖数组，
  // 是为了让事件订阅只建一次
  const savingRef = useRef(false);
  const discardingRef = useRef(false);
  const cleanedRef = useRef(false);
  // 「放弃修改？」那个弹窗正开着。它和上面三个不同：那三个是**结果**标记，这一个
  // 是**重入闸门** —— 下面挂了 `beforeRemove` 与 `BackHandler` 两个监听器，
  // 同一次返回有可能让它们依次求值，而 `shouldAllowLeave` 在「有改动」那条路上
  // 是「弹窗 + 返回 false」。没有这道闸门，第二次求值会在用户还没回应时再弹一个
  // 一模一样的框，他点掉一个又冒出一个。**必须同步置位**（所以是 ref 不是 state），
  // 否则两次求值之间隔的那一帧足够它再弹一次。
  const promptingRef = useRef(false);
  // 用户点「＋」进来时那次 `createTemplate`。返回键有可能赶在它 resolve 之前按下，
  // 而那一行迟早会写进库 —— 只有等它给出 id 才删得掉，所以把手里的 promise 存下来
  const creatingRef = useRef<Promise<string | null>>(Promise.resolve(null));
  // 本次新建的那套计划（`isNewPlanRef`）。用它才不会把用户原本就叫「新计划」的
  // 旧计划当成「＋」的临时产物删掉
  const isNewPlanRef = useRef(false);
  const nameRef = useRef(DEFAULT_PLAN_NAME);
  const exerciseIdsRef = useRef<string[]>([]);
  // 动作弹层开着没有。返回键的处理要根据它决定「关弹层」还是「退出这一屏」，
  // 而那个判断发生在事件回调里，所以同样要用 ref
  const pickerVisibleRef = useRef(false);

  // 下面几个 ref 每帧同步一次当前值：给事件回调（返回键、beforeRemove）读的
  // 都是它们，而不是可能要等一次重渲染才生效的 state
  nameRef.current = name;
  exerciseIdsRef.current = exerciseIds;
  pickerVisibleRef.current = pickerVisible;

  // 这一屏正在编辑哪个计划。
  //
  // 从 `id === 'new'` 进来时，真实 id 在 `newPlanIdRef` 里 —— 路由参数由
  // `router.setParams` 异步换成它，中间会有一两帧 `useLocalSearchParams` 还是
  // `'new'`。这两帧若拿 `'new'` 去查库就会闪一句「这个计划不存在」，
  // 所以这里优先用刚建出来的那个 id。
  const planId = newPlanIdRef.current ?? id;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 进入页面时取数。`planId === 'new'` 走新建分支：先建一个空计划拿到真实 id，
  // 再把路由参数换成它 —— 不换的话，后面每一次写库都要先问一句「这个计划建出来了没有」
  useEffect(() => {
    if (!planId) return undefined;
    let cancelled = false;

    if (planId === 'new') {
      // 只建一次（StrictMode 下这个 effect 会跑两遍，而每次都会写一行数据）
      if (createStartedRef.current) return undefined;
      createStartedRef.current = true;

      // 建出来就记进 `newPlanIdRef`（参数换成真实 id 之前的那两帧要靠它），
      // 同时把这次写入本身存进 `creatingRef` —— 用户可能在它 resolve 之前就按了返回，
      // 那时只有它手里有这个 id，才删得掉那行刚写进去的空计划
      const creation = createTemplate(exec, DEFAULT_PLAN_NAME)
        .then((created) => {
          newPlanIdRef.current = created.id;
          isNewPlanRef.current = true;
          return created.id;
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setError(e instanceof Error ? e.message : String(e));
            setLoaded(true);
          }
          return null;
        });
      creatingRef.current = creation;

      void creation.then((createdId) => {
        if (cancelled || createdId === null) return;
        // 换成真实 id：刷新页面、深链回退都不会再走一遍「新建」，
        // 返回栈里那一层也还是同一个计划
        router.setParams({ id: createdId });
      });

      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      setLoaded(false);
      setFound(false);
      setError(null);
      try {
        const detail = await getTemplate(exec, planId);
        if (cancelled) return;
        if (!detail) {
          setFound(false);
          setLoaded(true);
          return;
        }
        const ids = detail.exercises.map((item) => item.templateExercise.exerciseId);
        setName(detail.template.name);
        setExerciseIds(ids);
        setNames(
          Object.fromEntries(
            detail.exercises.map((item) => [
              item.templateExercise.exerciseId,
              item.exerciseName,
            ]),
          ),
        );
        setFound(true);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [exec, planId, router]);

  // 路由参数最终被换成真实 id 了：把那个「临时 id」清掉，后面一律以 URL 为准。
  //
  // 留着它反而是错的：用户在编辑页里从 A 改到 B（或返回后重新进来）时，
  // 这个残留的值会让新的一轮取数去查上一个计划
  useEffect(() => {
    if (id !== 'new' && newPlanIdRef.current !== id) {
      newPlanIdRef.current = null;
    }
  }, [id]);

  // 记下进入时的样子。必须等数据真的落进 state 之后再记，否则快照是空的，
  // 一进来就会被算成「有未保存改动」
  useEffect(() => {
    if (loaded) {
      initialRef.current = { name, exerciseIds };
    }
    // 故意只依赖 `loaded`：快照要在「加载完成」那一刻记一次，
    // 之后用户每一次编辑都会让它和当前值分开 —— 那正是「有改动」的定义
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  /**
   * 这一次返回能不能直接走。有需要拦的情况时顺手弹一句或清一下空计划，
   * 并返回 `false` 表示「先别走」。
   *
   * 判断顺序：已处理过 / 保存中 / 正在放弃 —— 直接放行；动作弹层开着 —— 关掉它
   * （返回键的最近一层含义总是「关掉眼前这个弹层」）；正在建一个空计划 ——
   * 等它建完，**顺手拿走它的 id** 再放行（此时库里那行还没写出来，直接放行就
   * 没人再来清它了）；本次新建且一个字都没改 —— 静默删掉它（用户点错了「＋」，
   * 不该留下痕迹）；有改动 —— 弹「放弃修改？」；其余 —— 放行。
   *
   * 读的全是 ref 而不是 state：它们的值在同一帧里就要用上，而 state 要等一次
   * 重渲染才生效，挡不住紧接着发生的那次返回。
   *
   * @returns true = 可以直接返回；false = 已经接管（关了弹层、清空计划中，或正在问用户）
   */
  const shouldAllowLeave = async (): Promise<boolean> => {
    if (cleanedRef.current) return true;
    if (savingRef.current || discardingRef.current) return true;
    // 闸门：弹窗已经开着就直接拦住。
    // 用户点「放弃」时 `discardingRef` 会置真（上面那句就放行了），点「继续编辑」
    // 则什么都不做、由弹窗把自己的回调清掉，所以这里返回 false 不会把他卡死。
    if (promptingRef.current) return false;

    // 动作弹层还开着：返回键该关的是它。不拦的话 `BackHandler` 会抢在
    // Modal 的 `onRequestClose` 之前把整屏退掉，用户「想关弹层」却丢了没保存的改动
    if (pickerVisibleRef.current) {
      setPickerVisible(false);
      return false;
    }

    // 「＋」刚点进来、`createTemplate` 还没返回：此刻库里那行还没写出来，
    // 现在放行就永远删不掉它了 —— 等它建完，把 id 记下来再放行
    if (planId === 'new') {
      setDeleting(true);
      try {
        const created = await creatingRef.current;
        if (created) newPlanIdRef.current = created;
      } catch {
        // 建都没建出来，那也没什么东西要清
      }
      if (mountedRef.current) setDeleting(false);
    }

    // 本次新建、名字没动过、一个动作都没加：这不是「用户的计划」，
    // 是「＋」按钮的临时产物，直接清掉，别拿「放弃修改？」烦他
    const untouched =
      isNewPlanRef.current &&
      nameRef.current === DEFAULT_PLAN_NAME &&
      exerciseIdsRef.current.length === 0;
    if (untouched) {
      cleanedRef.current = true;
      setDeleting(true);
      const createdId = newPlanIdRef.current;
      void (async () => {
        try {
          if (createdId) await deleteTemplate(exec, createdId);
        } catch (err) {
          // 删不掉就算了：留一个空计划比把用户卡在编辑页强。
          // 这里刻意不弹窗 —— 他按的是「返回」，不是「删除」
          console.warn('清理空计划失败', err);
        }
        if (mountedRef.current) setDeleting(false);
        navigation.goBack();
      })();
      return false;
    }

    // 还没取到数（快照还没记下）时没什么可丢的，放行
    const initial = initialRef.current;
    if (!initial) return true;
    const unchanged =
      nameRef.current === initial.name &&
      exerciseIdsRef.current.length === initial.exerciseIds.length &&
      exerciseIdsRef.current.every(
        (item, index) => item === initial.exerciseIds[index],
      );
    if (unchanged) return true;

    // 有改动：先拦下来问一句。Alert 是异步的，用户点完才会有下一步
    promptingRef.current = true;
    Alert.alert('放弃修改？', '改动还没保存。', [
      {
        text: '继续编辑',
        style: 'cancel',
        // 取消是**回调**，不在这里同步清闸门 —— 用户可能还要再试一次返回。
        // 只有真的点了某一项才算这一轮问完了
        onPress: () => {
          promptingRef.current = false;
        },
      },
      {
        text: '放弃',
        style: 'destructive',
        onPress: () => {
          promptingRef.current = false;
          discardingRef.current = true;
          navigation.goBack();
        },
      },
    ], {
      // Android 上直接按返回键也能把这个 Alert 关掉，而那条路**不会**走任何
      // 按钮的 onPress。不接这个回调的话闸门就永远关着，用户之后每次按返回都
      // 悄无声息（明明有未保存的改动，却既不问也不退）—— 那正是这道闸门想避免的
      // 反面。iOS 上 Alert 本来就不可点外关闭，所以这个回调是 Android 专用
      // （类型定义里也标了 `@platform android`）。
      onDismiss: () => {
        promptingRef.current = false;
      },
    });
    return false;
  };

  /**
   * 返回时拦一下：有未保存的改动要先问一句，本次新建又什么都没改的空计划要清掉。
   *
   * 两条路都要挂，缺一不可：
   * - `beforeRemove` 收的是**导航动作**，导航栏左上角的返回、手势返回都走它；
   * - `BackHandler` 收的是 **Android 的物理返回键** —— react-native-screens 的
   *   原生栈有可能在 JS 之前就把它处理掉（它自己的注释里就写着
   *   「beforeRemove 在 native-stack 上并非完全支持」），所以物理返回键单独兜一道。
   *
   * 两者不会同时生效：物理返回键在 `BackHandler` 这一层就被 `return true` 吃掉了，
   * 不会再产生导航动作，也就不会触发 `beforeRemove`。
   */
  useEffect(() => {
    // `shouldAllowLeave` 是异步的（可能要等空计划建出来才拿得到 id），
    // 这里必须真的 await 再决定要不要拦 —— 直接 `!shouldAllowLeave()` 是个
    // 永远为 false 的表达式（Promise 恒为真值），等于根本没拦
    const unsubscribe = navigation.addListener('beforeRemove', (e: any) => {
      e.preventDefault();
      void shouldAllowLeave().then((allow) => {
        if (allow) navigation.dispatch(e.data.action);
      });
    });
    return unsubscribe;
    // 只订阅一次：处理逻辑读的全是 ref，拿到的永远是最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Android 的物理返回键。返回 true 即「这次按键我处理了，别走默认行为」。
  // 同样是异步的，所以先无条件吃掉这次按键，再按判断结果决定要不要返回
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void shouldAllowLeave().then((allow) => {
        if (allow) navigation.goBack();
      });
      return true;
    });
    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 动作清单只在弹层打开时读一次：编辑计划的过程中库里不会新增动作，
  // 每次开弹层都全表重读纯属浪费
  useEffect(() => {
    if (!pickerVisible) return undefined;
    let cancelled = false;
    void (async () => {
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
   * 上移 / 下移一行动作。只动本地 state，不写库。
   *
   * @param index 这一行当前的下标
   * @param offset -1 上移，+1 下移
   * @returns 无返回值；越界时什么都不做
   */
  const moveRow = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= exerciseIds.length) return;
    setExerciseIds(moveItem(exerciseIds, index, target));
  };

  /**
   * 删掉一行动作。同样只动本地 state —— 点「保存」之前库里那份原封不动。
   *
   * @param index 要删的下标
   * @returns 无返回值
   */
  const removeRow = (index: number) => {
    setExerciseIds(exerciseIds.filter((_, i) => i !== index));
  };

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
   * 选中一个动作：追加到清单末尾（重复选同一个动作是允许的，有人真的会练两轮）。
   *
   * 这里唯一一处额外动作是把动作名塞进 `names`：只存 id 的话，新加的这一行会
   * 显示不出名字 —— 库里那份清单还没写过，查不到它。
   *
   * @param exercise 用户点的那一项
   * @returns 无返回值
   */
  const handlePickExercise = (exercise: Exercise) => {
    setExerciseIds([...exerciseIds, exercise.id]);
    setNames({ ...names, [exercise.id]: exercise.name });
    setPickerVisible(false);
  };

  /**
   * 保存：整体覆盖动作清单 + 改名，然后返回。
   *
   * 顺序是先动作后名字：两步之间用户看到的是同一个页面，反过来也不会更好；
   * 重要的是**两步都成功才返回** —— 只写了一半就退出去，用户会以为整份改动
   * 都保存了。
   *
   * @returns 无返回值；失败时弹窗并留在页面上
   */
  const handleSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      // 写的是 `planId` 而不是路由参数：新建的计划在这两帧里参数可能还是 `'new'`
      await setTemplateExercises(exec, planId, exerciseIds);
      await renameTemplate(exec, planId, name.trim() || DEFAULT_PLAN_NAME);
      // 保存之后返回不再需要拦：改动已经落库，而且自己主动返回会先经过
      // `beforeRemove` 那个监听器
      cleanedRef.current = true;
      navigation.goBack();
    } catch (e) {
      savingRef.current = false;
      setSaving(false);
      Alert.alert('没能保存', e instanceof Error ? e.message : String(e));
    }
  };

  // 弹层与记录页那份同构：`Modal` + `TextInput` 搜索 + `FlatList` 按肌群分组。
  //
  // 本 Task 先在本文件内实现一份，M8 的 Task 13 会把它抽成共用组件并让这里改用
  // 共用版 —— 现在不抽，是为了让这一轮能独立验收，不跨轮次依赖。
  const pickerModal = (
    <Modal
      visible={pickerVisible}
      transparent
      animationType="slide"
      // Android 的物理返回键 / 手势返回：不接这个回调，返回键会直接退出整屏
      onRequestClose={closePicker}
    >
      <View style={styles.modalRoot}>
        <Pressable style={styles.modalBackdrop} onPress={closePicker} />
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text variant="title" style={styles.sheetTitle}>
              选择动作
            </Text>
            <Pressable
              style={styles.sheetCancel}
              onPress={closePicker}
              accessibilityRole="button"
              accessibilityLabel="取消"
            >
              <Text variant="body" style={styles.sheetCancelText}>
                取消
              </Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="搜索动作名称"
            // 占位文字必须跟着主题走，否则浅色主题下会是几乎看不见的白
            placeholderTextColor={palette.textFaint}
            returnKeyType="search"
            autoCorrect={false}
          />

          <FlatList
            data={visibleGroups}
            keyExtractor={(group) => group.title}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item: group }) => (
              <View>
                <Text variant="label" style={styles.groupTitle}>
                  {group.title}
                </Text>
                {group.data.map((exercise) => (
                  <Pressable
                    key={exercise.id}
                    style={styles.option}
                    onPress={() => handlePickExercise(exercise)}
                    accessibilityRole="button"
                    accessibilityLabel={`添加动作：${exercise.name}`}
                  >
                    <Text variant="body" style={styles.optionText}>
                      {exercise.name}
                    </Text>
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

  // 正在新建：路由参数还是 `'new'`，真实 id 还没拿到。这期间屏幕上是转圈 ——
  // **绝不能**渲染编辑界面，此时 `planId` 是那个不存在的 `'new'`，
  // 点「保存」就会往一个不存在的 id 上写
  const creating = planId === 'new';

  // 没得编辑：要么取数失败，要么这个计划真的不存在（被别处删掉了，或是深链进来
  // 的野 id）。新建分支不算 —— 它的 id 在换成真实 id 之前本来就「查不到」
  if (error !== null || (!creating && loaded && !found)) {
    return (
      <Screen edgeToEdgeTop={false} style={styles.stateContainer}>
        <Stack.Screen options={{ title: '编辑计划' }} />
        <Text variant="title" color="textMuted" style={styles.stateHint}>
          {error ?? '这个计划不存在'}
        </Text>
        <Button label="返回" onPress={() => router.back()} fullWidth={false} />
      </Screen>
    );
  }

  if (!loaded || creating) {
    return (
      <Screen edgeToEdgeTop={false} style={styles.stateContainer}>
        <Stack.Screen options={{ title: '编辑计划' }} />
        <ActivityIndicator color={palette.accent} />
      </Screen>
    );
  }

  return (
    <Screen edgeToEdgeTop={false}>
      {/* 导航栏标题与右上角的「保存」：这一页的顶栏全部交给原生导航栏，
          白拿返回手势与安全区处理 */}
      <Stack.Screen
        options={{
          title: '编辑计划',
          headerRight: () => (
            <Pressable
              onPress={() => {
                void handleSave();
              }}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="保存"
              accessibilityState={{ disabled: saving, busy: saving }}
              style={({ pressed }) => ({ opacity: saving ? 0.4 : pressed ? 0.6 : 1 })}
            >
              <Text variant="title" style={{ color: palette.accent }}>
                {saving ? '保存中…' : '保存'}
              </Text>
            </Pressable>
          ),
        }}
      />

      {deleting ? (
        <View style={styles.deletingRow}>
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : null}

      <Text variant="caption" color="textMuted">
        计划名
      </Text>
      <TextInput
        style={styles.nameInput}
        value={name}
        onChangeText={setName}
        placeholder="计划名，比如「推日」"
        placeholderTextColor={palette.textFaint}
        returnKeyType="done"
        maxLength={40}
      />
      <Text variant="caption" color="textFaint">
        编排好之后，开始训练时会按计划列表里的顺序自动轮转到这一套。
      </Text>

      <FlatList
        style={{ flex: 1 }}
        data={exerciseIds}
        keyExtractor={(exerciseId, index) => `${exerciseId}-${index}`}
        contentContainerStyle={{ paddingTop: space.md, paddingBottom: space.lg }}
        ListHeaderComponent={
          <Text variant="caption" color="textMuted">
            动作清单（顺序就是这次训练里的顺序）
          </Text>
        }
        renderItem={({ item: exerciseId, index }) => {
          const isFirst = index === 0;
          const isLast = index === exerciseIds.length - 1;
          return (
            <View style={styles.exerciseRow}>
              <Text variant="numeric" style={styles.exerciseIndex}>
                {index + 1}
              </Text>
              <Text variant="body" style={styles.exerciseName} numberOfLines={1}>
                {names[exerciseId] ?? '未知动作'}
              </Text>

              <Pressable
                onPress={() => moveRow(index, -1)}
                disabled={isFirst}
                style={({ pressed }) => [
                  styles.iconButton,
                  {
                    borderColor: palette.border,
                    backgroundColor: palette.surfaceRaised,
                    opacity: isFirst ? 0.35 : pressed ? 0.5 : 1,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel="上移"
                accessibilityState={{ disabled: isFirst }}
              >
                <Text variant="body" style={styles.iconButtonText}>
                  ↑
                </Text>
              </Pressable>

              <Pressable
                onPress={() => moveRow(index, 1)}
                disabled={isLast}
                style={({ pressed }) => [
                  styles.iconButton,
                  {
                    borderColor: palette.border,
                    backgroundColor: palette.surfaceRaised,
                    opacity: isLast ? 0.35 : pressed ? 0.5 : 1,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel="下移"
                accessibilityState={{ disabled: isLast }}
              >
                <Text variant="body" style={styles.iconButtonText}>
                  ↓
                </Text>
              </Pressable>

              <Pressable
                onPress={() => removeRow(index)}
                style={({ pressed }) => [
                  styles.iconButton,
                  {
                    borderColor: palette.border,
                    backgroundColor: palette.surfaceRaised,
                    opacity: pressed ? 0.5 : 1,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`从计划里移除第 ${index + 1} 个动作`}
              >
                <Text variant="body" style={styles.removeText}>
                  ✕
                </Text>
              </Pressable>
            </View>
          );
        }}
        ListEmptyComponent={
          <Text variant="caption" color="textMuted" style={styles.stateHint}>
            这一套计划还没有动作。点下面的「＋　添加动作」挑几个。
          </Text>
        }
        ListFooterComponent={
          <Button
            label="＋　添加动作"
            variant="secondary"
            onPress={openPicker}
            accessibilityLabel="添加动作"
            style={{ marginTop: space.sm }}
          />
        }
      />

      {pickerModal}
    </Screen>
  );
}

/**
 * 这一屏用到的全部样式。
 *
 * **写成 hook 而不是模块级的 `StyleSheet.create`**：颜色来自主题，而主题在运行时
 * 才定（跟随系统明暗）。模块级常量在模块加载时就固化了，拿不到主题。
 *
 * @returns 绑定了当前主题的样式对象
 */
function usePlanEditStyles() {
  const palette = usePalette();

  return useMemo(
    () => ({
      stateContainer: { justifyContent: 'center' as const, gap: space.md },
      stateHint: { textAlign: 'center' as const },
      deletingRow: { paddingVertical: space.sm, alignItems: 'center' as const },

      nameInput: {
        backgroundColor: palette.surfaceRaised,
        borderRadius: radius.md,
        borderWidth: border.hairline,
        borderColor: palette.border,
        paddingHorizontal: space.md,
        paddingVertical: space.md,
        fontSize: fontSize.h2,
        fontWeight: weight.medium,
        color: palette.text,
      },

      exerciseRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: space.sm,
        paddingVertical: space.sm,
        borderBottomWidth: border.hairline,
        borderBottomColor: palette.border,
      },
      // 序号用等宽数字，两位数动作数（10、11）也不会让名字列左右错开
      exerciseIndex: {
        width: 24,
        fontSize: fontSize.caption,
        color: palette.textFaint,
      },
      // 动作名吃掉剩余宽度；右侧三个按钮固定大小，行与行的按钮才能对齐
      exerciseName: { flex: 1, color: palette.text },
      iconButton: {
        width: 36,
        height: 36,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderRadius: radius.sm,
        borderWidth: border.hairline,
      },
      iconButtonText: { color: palette.text },
      removeText: { color: palette.danger },

      // 动作选择弹层（与记录页那份同构）
      modalRoot: { flex: 1, justifyContent: 'flex-end' as const },
      // 不用 `StyleSheet.absoluteFillObject`：这一版 react-native 的类型里已经
      // 没有这个导出了（只剩 `absoluteFill`），直接写全 absolute 四边更省事
      modalBackdrop: {
        position: 'absolute' as const,
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.55)',
      },
      sheet: {
        maxHeight: '80%' as const,
        backgroundColor: palette.surface,
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.xl,
        gap: space.md,
      },
      sheetHeader: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
      },
      sheetTitle: { fontSize: fontSize.title, fontWeight: weight.bold },
      sheetCancel: { paddingHorizontal: space.sm, paddingVertical: space.xs },
      sheetCancelText: {
        fontSize: fontSize.body,
        color: palette.accent,
        fontWeight: weight.medium,
      },
      search: {
        backgroundColor: palette.surfaceRaised,
        borderRadius: radius.md,
        borderWidth: border.hairline,
        borderColor: palette.border,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        fontSize: fontSize.body,
        color: palette.text,
      },
      groupTitle: {
        fontSize: fontSize.label,
        color: palette.textMuted,
        letterSpacing: tracking.label,
        marginTop: space.md,
        marginBottom: space.xs,
      },
      option: {
        paddingVertical: space.md,
        borderBottomWidth: border.hairline,
        borderBottomColor: palette.border,
      },
      optionText: { fontSize: fontSize.body, color: palette.text },
      emptyHint: {
        textAlign: 'center' as const,
        color: palette.textMuted,
        paddingVertical: space.xl,
      },
    }),
    [palette],
  );
}
