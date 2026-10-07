import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';

import { ExercisePickerModal } from '../../src/components/ExercisePickerModal';
import { Stepper } from '../../src/components/Stepper';
import type { CsvParseResult, CsvSource } from '../../src/domain/csv';
import { parseWorkoutCsv } from '../../src/domain/csv';
import type { ImportedWorkout } from '../../src/domain/importRecords';
import { normalizeExerciseName } from '../../src/domain/importRecords';
import type { Exercise } from '../../src/domain/types';
import { pickTextFile } from '../../src/lib/backupFile';
import { formatDateFull, formatTime } from '../../src/lib/format';
import { useDatabase } from '../../src/repositories/database';
import { listExercises } from '../../src/repositories/exerciseRepo';
import { importWorkouts } from '../../src/repositories/importRepo';
import {
  Button,
  Card,
  Screen,
  Text,
  border,
  fontSize,
  radius,
  space,
  usePalette,
  weight,
} from '../../src/ui';

/**
 * 记录管理页：CSV 导入（带预览）与手动补记录。
 *
 * **两个模式共用一个路由**（`?mode=csv|manual`），因为它们落库走的是同一个
 * `importWorkouts`。分成两个文件之后，「两条路只有攒数据的方式不同」这件事就没有
 * 结构来保证，迟早会有一边被改漏（比如一边写了 `completed_at`、另一边忘了），
 * 而症状是进步曲线上莫名其妙少点 —— 那种 bug 极难定位。
 *
 * 这一屏是**终端界面**：它不产出任何别处要用的东西，只把两种输入方式变成
 * `ImportedWorkout[]` 交给落库层。
 */

/** 年份下限。`Stepper` 只有下限、没有上限，所以上下两端都得这里自己夹 */
const MIN_YEAR = 1970;

/**
 * 组数上限。
 *
 * `Stepper` 的「不设上限」是有意的（不同器械的最大配重差得很远），但组数在现实里
 * 不会超过 20 —— 上限是**这一处业务**的规则，所以夹取写在表单里，不去改组件。
 */
const MAX_SET_COUNT = 20;

/** 时长下限 / 上限（分钟）。上限 10 小时，够任何一次真实训练 */
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 600;
/** 时长步长：5 分钟一档，没人会去为了一分钟反复点 */
const DURATION_STEP_MINUTES = 5;

/** 分钟的步长与上限：`Stepper` 没有 `max`，55 要自己夹（60 会滚到下一个小时） */
const MINUTE_STEP = 5;
const MAX_MINUTE = 55;

/** 新加的动作的默认值：与记录页的起步值一致（20 kg × 8，3 组） */
const DEFAULT_WEIGHT_KG = 20;
const DEFAULT_REPS = 8;
const DEFAULT_SET_COUNT = 3;

/** 时长默认 45 分钟 —— 一次常规训练的中间值 */
const DEFAULT_DURATION_MINUTES = 45;

/** 预览里最多列出几个「将新建」的动作名，多出来的用「等 N 个」概括 */
const MAX_LISTED_NEW_EXERCISES = 5;

/** 来源 → 界面上写给用户看的名字 */
const SOURCE_LABELS: Record<CsvSource, string> = {
  strong: 'Strong',
  hevy: 'Hevy',
  xunji: '训记',
  // 认不出来时这一行根本不会渲染（见预览的分支），这里只是把类型补全
  unknown: '未知来源',
};

/**
 * 把数字夹进 `[min, max]`。
 *
 * 存在的唯一理由：`Stepper` 只有下限没有上限（见它的组件注释），而这一屏有六处
 * 需要上限（年 / 月 / 日 / 时 / 分 / 组数）。
 *
 * @param value 用户点出来的值
 * @param min 下限
 * @param max 上限
 * @returns 夹好之后的值
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 某年某月有多少天。
 *
 * `new Date(year, month, 0)` 是「这个月的第 0 天」，也就是上个月的最后一天，
 * 取它的 `getDate()` 正好得到这个月的天数，闰年由 `Date` 自己处理。
 *
 * @param year 四位年份
 * @param month 月份，1~12（**不是** `Date` 的 0~11）
 * @returns 这个月的天数（28~31）
 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * 预览要显示的全部派生数据。在**确认之前**一次算清：按下「确认导入」时就只剩写库，
 * 不会再有任何取数或比对，按钮的 loading 也就不会盖住一次意外的等待。
 */
interface CsvPreviewData {
  /** 解析器的原始结果（场数、跳过、磅换算都在里面） */
  result: CsvParseResult;
  /** 文件里出现过的不同动作个数，按归一化名去重 —— 与落库的合并规则一致 */
  exerciseCount: number;
  /** 本机动作库里没有的动作名（去重、按拼音排序），落库时会被建成自定义动作 */
  newExerciseNames: string[];
}

/**
 * 比较解析结果与本机动作库，算出预览要的那几个数。
 *
 * 「哪些动作本机没有」**必须复用 `normalizeExerciseName`**：落库时就是用这个规则
 * 去 `exercise` 表里找同名动作的。预览若自己写一遍比较（比如直接比字符串），
 * 「卧推（窄距）」与「卧推(窄距)」这种全角/半角差别会让预览说「3 个本机没有」、
 * 实际却只建了 1 个 —— 用户看到对不上的数字就再也不会相信这个预览页。
 *
 * @param result `parseWorkoutCsv` 的结果
 * @param localExercises `listExercises` 的结果（本机动作库）
 * @returns 预览用的派生数据
 */
function buildPreview(
  result: CsvParseResult,
  localExercises: Exercise[],
): CsvPreviewData {
  const local = new Set(
    localExercises.map((exercise) => normalizeExerciseName(exercise.name)),
  );

  // 归一化名 → 文件里的原始写法。同一场里的「卧推（窄距）」与「卧推(窄距)」在落库时
  // 会合并成一个动作，这里也只会数一个 —— 预览的数必须与落库后的结果对得上
  const inFile = new Map<string, string>();
  for (const workout of result.workouts) {
    for (const item of workout.exercises) {
      const key = normalizeExerciseName(item.name);
      if (!inFile.has(key)) inFile.set(key, item.name);
    }
  }

  const newExerciseNames = [...inFile.entries()]
    .filter(([key]) => !local.has(key))
    .map(([, name]) => name)
    // 拼音序，与动作库列表（`listExercises`）的排法一致；默认的码点比较对中文没有意义
    .sort((a, b) => a.localeCompare(b, 'zh'));

  return { result, exerciseCount: inFile.size, newExerciseNames };
}

/**
 * 一批训练覆盖的日期范围。
 *
 * 不假设解析结果的顺序：这一行是给用户核对「要导的是不是这段时间」用的，
 * 宁可在几百条上多走一遍循环，也不要因为顺序变了而显示一个错的区间。
 *
 * @param workouts 解析出来的训练（**调用方保证非空**）
 * @returns 最早与最晚的开始时间
 */
function startedAtRange(workouts: ImportedWorkout[]): { from: number; to: number } {
  let from = workouts[0].startedAt;
  let to = workouts[0].startedAt;
  for (const workout of workouts) {
    if (workout.startedAt < from) from = workout.startedAt;
    if (workout.startedAt > to) to = workout.startedAt;
  }
  return { from, to };
}

/** 手动模式里的一行动作。重量 / 次数 / 组数是三个独立可调的字段 */
interface ManualExercise {
  /** 动作 id。落库时用不上（`importWorkouts` 按**名字**匹配），但它是列表 key 的一半 */
  exerciseId: string;
  name: string;
  /** 公斤 */
  weight: number;
  /** 每组的次数 */
  reps: number;
  /** 组数，1~`MAX_SET_COUNT` */
  setCount: number;
}

/**
 * 记录管理页。
 *
 * @returns CSV 模式：选文件 → 预览 → 确认导入；手动模式：一张表单，保存后返回
 */
export default function ImportScreen() {
  const exec = useDatabase();
  const router = useRouter();
  // 参数可能在别处被拼成数组（`?mode=a&mode=b`），所以只认字符串那一种
  const params = useLocalSearchParams();

  // 绑定了当前主题的样式。必须在顶层取一次，两个模式共用
  const styles = useImportStyles();
  // 训练名输入框的占位文字色也要跟主题走
  const palette = usePalette();

  // 只有 `manual` 是有效值，其余（没带参数、带了个别的、带了数组）一律当 CSV 导入
  const isManual = params.mode === 'manual';

  // ---------------------------------------------------------------------------
  // CSV 模式
  // ---------------------------------------------------------------------------

  // 两个阶段。计划里画的那个「成功提示」阶段不是一屏，而是 `Alert` + 返回，
  // 所以没有对应的 state。
  const [stage, setStage] = useState<'idle' | 'preview'>('idle');
  // 解析结果 + 与动作库比对出来的名单。`null` 表示还没选到文件
  const [preview, setPreview] = useState<CsvPreviewData | null>(null);
  // 正在选文件 / 读文件：挡住重复点击（文件选择器起来得慢）
  const [picking, setPicking] = useState(false);
  // 正在写库：挡住重复提交 —— 几百行的 INSERT 要走好几秒，重复点击会跑第二遍
  const [importing, setImporting] = useState(false);
  // 「读不懂」那一行是否展开
  const [skippedOpen, setSkippedOpen] = useState(false);

  /**
   * 三件耗时的事（选文件 / 导入 / 保存）各有一个「已经开始了」的 ref。
   *
   * 光靠 `disabled` 不够：它要等一次重渲染才生效，手快连点两下时第二次点击可能
   * 赶在重渲染之前（`app/plan/[id].tsx` 的保存按钮也是这么处理的）。导入尤其不能
   * 重复跑 —— 一次要写几百行。
   */
  const pickingRef = useRef(false);
  const importingRef = useRef(false);
  const savingRef = useRef(false);

  // ---------------------------------------------------------------------------
  // 手动模式
  // ---------------------------------------------------------------------------

  // 日期时间默认「现在」。用惰性初始化而不是 `useMemo`：这几个值一旦被用户改过，
  // 就不该再跟着时间走。分钟取整到 5 的倍数，否则默认值不在步进器的档位上，
  // 第一次点「＋」会跳到一个奇怪的值
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [day, setDay] = useState(() => new Date().getDate());
  const [hour, setHour] = useState(() => new Date().getHours());
  const [minute, setMinute] = useState(
    () => Math.floor(new Date().getMinutes() / MINUTE_STEP) * MINUTE_STEP,
  );
  // 训练名是这一屏唯一的文本输入，空着就存 null
  const [name, setName] = useState('');
  const [duration, setDuration] = useState(DEFAULT_DURATION_MINUTES);
  // 本地可编辑的动作清单。点「保存」才把它组装成 `ImportedWorkout` 写库
  const [rows, setRows] = useState<ManualExercise[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  /**
   * 五个步进器拼出来的开始时刻。
   *
   * 用 `new Date(y, m - 1, d, ...)` 按**本地时区**构造，与 `csv.ts` 里
   * `buildTimestamp` 的做法一致 —— 不用 `Date.parse`，它在不同 JS 引擎上对无时区
   * 字符串的解释不一样。
   */
  const startedAt = useMemo(
    () => new Date(year, month - 1, day, hour, minute, 0, 0).getTime(),
    [year, month, day, hour, minute],
  );

  /**
   * 改年份。顺手把「日」重新夹进这个月的天数。
   *
   * 上限是今年：不夹的话用户能一路按到 3000 年，而那条记录会永远排在他历史列表
   * 的最上面，把真正的记录全挤到后面。
   *
   * @param next 步进器给出的新年份
   * @returns 无返回值
   */
  const handleYearChange = (next: number) => {
    const clamped = clamp(next, MIN_YEAR, new Date().getFullYear());
    setYear(clamped);
    setDay((current) => clamp(current, 1, daysInMonth(clamped, month)));
  };

  /**
   * 改月份。月份一变，这一个月的天数就可能变少，所以「日」必须重新夹 ——
   * 从 1 月 31 日拨到 2 月之后就造出了「2 月 31 日」，而 `importWorkouts` 会把它
   * 原样交给 SQLite 存下来，历史里就出现一条不存在的日期。
   *
   * @param next 步进器给出的新月份
   * @returns 无返回值
   */
  const handleMonthChange = (next: number) => {
    const clamped = clamp(next, 1, 12);
    setMonth(clamped);
    setDay((current) => clamp(current, 1, daysInMonth(year, clamped)));
  };

  /**
   * 改「日」。上限是这个月的实际天数。
   *
   * @param next 步进器给出的新日期
   * @returns 无返回值
   */
  const handleDayChange = (next: number) => {
    setDay(clamp(next, 1, daysInMonth(year, month)));
  };

  /**
   * 改小时。0~23，不夹的话会造出「25 时」这种被 `Date` 悄悄滚到第二天的值。
   *
   * @param next 步进器给出的新小时
   * @returns 无返回值
   */
  const handleHourChange = (next: number) => {
    setHour(clamp(next, 0, 23));
  };

  /**
   * 改分钟。0~55、步长 5：60 会被 `Date` 滚到下一个小时，用户看到的时间就和他
   * 点出来的数对不上了。
   *
   * @param next 步进器给出的新分钟
   * @returns 无返回值
   */
  const handleMinuteChange = (next: number) => {
    setMinute(clamp(next, 0, MAX_MINUTE));
  };

  /**
   * 改时长（分钟）。
   *
   * @param next 步进器给出的新时长
   * @returns 无返回值
   */
  const handleDurationChange = (next: number) => {
    setDuration(clamp(next, MIN_DURATION_MINUTES, MAX_DURATION_MINUTES));
  };

  /**
   * 改某个动作的某个字段。
   *
   * 用函数式更新：步进器连点时，闭包里的 `rows` 可能已经过期，直接基于它算新数组
   * 会丢掉上一次的改动（表现是「连着点两下，只有一下生效」）。
   *
   * @param index 第几行动作
   * @param patch 要覆盖的字段
   * @returns 无返回值
   */
  const updateRow = (index: number, patch: Partial<ManualExercise>) => {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  /**
   * 删掉一行动作。只动本地数组，没保存就返回的话库里什么都没有。
   *
   * @param index 要删的下标
   * @returns 无返回值
   */
  const removeRow = (index: number) => {
    setRows((current) => current.filter((_, i) => i !== index));
  };

  /**
   * 选中一个动作并加到清单末尾。重复选同一个动作是允许的（有人真的会练两轮）。
   *
   * @param exercise 用户在弹层里点的那一项
   * @returns 无返回值；无论加成功与否都关掉弹层 —— 这里的「加」不会失败
   */
  const handleAddExercise = (exercise: Exercise) => {
    setRows((current) => [
      ...current,
      {
        exerciseId: exercise.id,
        name: exercise.name,
        weight: DEFAULT_WEIGHT_KG,
        reps: DEFAULT_REPS,
        setCount: DEFAULT_SET_COUNT,
      },
    ]);
    setPickerVisible(false);
  };

  /**
   * 选一个 CSV 文件 → 解析 → 进预览。
   *
   * 解析、与动作库比对都在**确认之前**做完：用户按下「确认导入」时不会再有任何
   * 取数或计算，那个按钮只负责写库。
   *
   * @returns 无返回值。用户取消时什么都不做也不弹（取消不是错误）；失败时把
   *   `pickTextFile` 抛出的中文错误弹出来，并留在原地让用户重选
   */
  const handlePickFile = useCallback(async () => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    setPicking(true);
    try {
      const text = await pickTextFile();
      // 取消：不弹任何东西，停在原来那一屏。这里**不能**把 null 当失败
      if (text === null) return;

      const result = parseWorkoutCsv(text);
      // 认不出格式时 `workouts` 是空的，预览会走「选错文件」的兜底分支，
      // 所以这里不必单独判 `detected.source`
      const localExercises = await listExercises(exec);
      setPreview(buildPreview(result, localExercises));
      // 换了一份文件，上一次的展开状态不能带过来
      setSkippedOpen(false);
      setStage('preview');
    } catch (error) {
      Alert.alert('导入失败', error instanceof Error ? error.message : String(error));
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  }, [exec]);

  /**
   * 确认导入：把预览里那些训练整批写进库。
   *
   * 成功后的 Alert 必须 `cancelable: false`：Android 上点对话框外面或按返回键会把
   * 它关掉，而那条路**不触发任何按钮回调** —— 返回就永远不会执行，用户留在预览屏
   * 上以为没导进去，再点一次就是第二份重复数据。
   *
   * @returns 无返回值；失败时把原始错误弹出来并留在预览屏（事务已回滚，库里没变）
   */
  const handleConfirmImport = useCallback(async () => {
    if (importingRef.current || preview === null) return;
    importingRef.current = true;
    setImporting(true);
    try {
      const result = await importWorkouts(exec, preview.result.workouts);
      Alert.alert(
        '导入完成',
        `导入 ${result.sessions} 场训练、${result.exercises} 个动作（其中 ${result.createdExercises} 个是新建的）。`,
        [{ text: '好', onPress: () => router.back() }],
        { cancelable: false },
      );
      // 成功后**不**复位 `importing`（也不复位那个 ref）：按钮一直转到离开这一屏
      // 为止，挡住「弹窗还开着、用户又点了一次确认导入」这种重复写入
    } catch (error) {
      importingRef.current = false;
      setImporting(false);
      Alert.alert('导入失败', error instanceof Error ? error.message : String(error));
    }
  }, [exec, preview, router]);

  /**
   * 保存手动填的这一条记录。
   *
   * 组装出来的 `ImportedWorkout` 与 CSV 解析出来的**是同一种东西**，落库也走
   * 同一个 `importWorkouts([workout])` —— 两条路只有「怎么攒出这个数组」不同。
   *
   * @returns 无返回值。动作一个都没有时不写库；成功后直接返回（历史里马上能看到，
   *   再弹一个「已保存」只是多一次点击）
   */
  const handleSave = useCallback(async () => {
    if (savingRef.current) return;
    // 界面上先说一句，比让 `validateImportedWorkouts` 抛「第 1 条记录一个动作都没有」
    // 友好得多（那句是给日志看的）
    if (rows.length === 0) {
      Alert.alert('至少加一个动作', '点下面的「＋　添加动作」挑一个再保存。');
      return;
    }

    const workout: ImportedWorkout = {
      startedAt,
      // 时长决定结束时间。这里不可能出现 finishedAt < startedAt（时长的下限是 5 分钟）
      finishedAt: startedAt + duration * 60_000,
      name: name.trim() === '' ? null : name.trim(),
      exercises: rows.map((row) => ({
        name: row.name,
        // 组数展开成一组一条：界面上一行「3 组」在库里必须是三条 set_entry，
        // 否则容量负荷与进步曲线都只算得一组
        sets: Array.from({ length: row.setCount }, () => ({
          weight: row.weight,
          reps: row.reps,
        })),
      })),
    };

    setSaving(true);
    savingRef.current = true;
    try {
      await importWorkouts(exec, [workout]);
      router.back();
    } catch (error) {
      savingRef.current = false;
      setSaving(false);
      Alert.alert('没能保存', error instanceof Error ? error.message : String(error));
    }
  }, [duration, exec, name, rows, router, startedAt]);

  /**
   * CSV 模式：还没选文件时那一屏。
   *
   * @returns 说明文字 + 选文件按钮
   */
  const renderCsvIdle = () => (
    <Card style={{ gap: space.sm }}>
      <Text variant="title">从其他 App 导入</Text>
      <Text variant="body" color="textMuted">
        支持 Strong、Hevy、训记导出的 CSV。选好文件后会先给你看一份预览，
        确认之前不会往库里写任何东西。
      </Text>
      <Button
        label="选择 CSV 文件"
        onPress={() => {
          void handlePickFile();
        }}
        loading={picking}
        loadingLabel="读取中…"
        disabled={picking}
        style={{ marginTop: space.sm }}
      />
    </Card>
  );

  /**
   * CSV 模式：预览屏。
   *
   * 三条「有就渲染、没有就整行不渲染」的规则都在这里：
   * 没有读不懂的行就不出现「读不懂」那一行，没有磅就不出现「单位换算」那一行，
   * 而**一场都没解析出来时连「确认导入」按钮都不给** —— 导 0 场只会让用户以为
   * 自己导进去了。
   *
   * @param data 选文件时算好的预览数据
   * @returns 预览内容
   */
  const renderCsvPreview = (data: CsvPreviewData) => {
    const { result } = data;

    // 「选错文件」的兜底。这一屏只给两个出口：换一个文件，或者干脆不导
    if (result.workouts.length === 0) {
      return (
        <Card style={{ gap: space.sm }}>
          <Text variant="title">这个文件里没有能识别的训练记录</Text>
          <Text variant="body" color="textMuted">
            请确认选的是从其他 App 导出的训练记录 CSV。
          </Text>
          <Button
            label="重新选择"
            variant="secondary"
            onPress={() => {
              void handlePickFile();
            }}
            loading={picking}
            loadingLabel="读取中…"
            disabled={picking}
            style={{ marginTop: space.sm }}
          />
          <Button label="取消" variant="ghost" onPress={() => router.back()} />
        </Card>
      );
    }

    const range = startedAtRange(result.workouts);
    const newNames = data.newExerciseNames;
    const listedNames = newNames.slice(0, MAX_LISTED_NEW_EXERCISES);
    // 超过 5 个就只列前 5 个，后面用总数概括 —— 一行里塞 30 个动作名没人会读
    const newNamesText =
      newNames.length > MAX_LISTED_NEW_EXERCISES
        ? `${listedNames.join('、')} 等 ${newNames.length} 个`
        : listedNames.join('、');

    return (
      <>
        <Text variant="h2">准备导入 {result.workouts.length} 场训练</Text>
        {/* 来源说给用户听：他得知道我们把这堆列当成了哪家的格式（`detected` 就是为此留的） */}
        {result.detected.source !== 'unknown' ? (
          <Text variant="caption" color="textFaint">
            识别为 {SOURCE_LABELS[result.detected.source]} 导出的 CSV
          </Text>
        ) : null}

        <Card style={{ gap: space.md }}>
          <InfoRow
            label="时间范围"
            value={`${formatDateFull(range.from)} ~ ${formatDateFull(range.to)}`}
          />
          <InfoRow
            label="涉及动作"
            value={
              newNames.length > 0
                ? `${data.exerciseCount} 个，其中 ${newNames.length} 个本机没有`
                : `${data.exerciseCount} 个，本机都有`
            }
            hint={
              newNames.length > 0
                ? `（将新建为自定义动作：${newNamesText}）`
                : undefined
            }
          />
          {/* 没有磅的时候整行不渲染：「已把 0 行换算成公斤」是纯噪音 */}
          {result.poundsConverted > 0 ? (
            <InfoRow
              label="单位换算"
              value={`已把 ${result.poundsConverted} 行磅换算成公斤`}
            />
          ) : null}
          {/* 同理：没有读不懂的行时这一行根本不出现 */}
          {result.skipped.length > 0 ? (
            <View style={styles.skippedBlock}>
              <View style={styles.skippedHeader}>
                <Text variant="caption" color="textMuted" style={styles.infoLabel}>
                  读不懂
                </Text>
                <Text variant="body" style={styles.infoValue}>
                  {result.skipped.length} 行会被跳过
                </Text>
                {/* 触区撑到 44dp 高而视觉上仍是一行小字：这一行不是主操作，
                    但也不该让人戳不准（与记录页「删除动作」同一套做法） */}
                <Pressable
                  onPress={() => setSkippedOpen((open) => !open)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: skippedOpen }}
                  accessibilityLabel={
                    skippedOpen ? '收起读不懂的行' : '展开读不懂的行'
                  }
                  hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
                >
                  <Text variant="caption" style={styles.toggleText}>
                    {skippedOpen ? '收起' : '展开'}
                  </Text>
                </Pressable>
              </View>
              {skippedOpen ? (
                <View style={styles.skippedList}>
                  {result.skipped.map((item) => (
                    // 行号在文件里唯一，可以当 key
                    <Text key={item.line} variant="caption" color="textMuted">
                      第 {item.line} 行：{item.reason}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </Card>

        {/* `loading` + `disabled`：一次要写几百行，重复点击会跑第二遍 */}
        <Button
          label="确认导入"
          onPress={() => {
            void handleConfirmImport();
          }}
          loading={importing}
          loadingLabel="导入中…"
          disabled={importing}
        />
        <Button
          label="取消"
          variant="secondary"
          onPress={() => router.back()}
          disabled={importing}
        />
      </>
    );
  };

  /**
   * 手动模式的表单。
   *
   * 五个 `Stepper` 而不是一个文本框：在手机上敲 `2024-01-15` 是件苦差事，
   * 而键盘类型、格式校验、非法日期三件事都要自己处理。步进器的手感也和记录页
   * 调重量 / 次数一致。
   *
   * @returns 表单内容
   */
  const renderManual = () => (
    <>
      <Text variant="caption" color="textMuted">
        日期与时间
      </Text>
      <Card style={styles.formCard}>
        <View style={styles.stepperGroup}>
          <Stepper label="年" value={year} step={1} min={MIN_YEAR} onChange={handleYearChange} />
          <Stepper label="月" value={month} step={1} min={1} onChange={handleMonthChange} />
          <Stepper label="日" value={day} step={1} min={1} onChange={handleDayChange} />
        </View>
        <View style={styles.stepperGroup}>
          <Stepper label="小时" value={hour} step={1} min={0} onChange={handleHourChange} />
          <Stepper
            label="分钟"
            value={minute}
            step={MINUTE_STEP}
            min={0}
            onChange={handleMinuteChange}
          />
        </View>
        {/* 把拼出来的时刻写一遍：夹取（比如 1 月 31 日拨到 2 月）之后用户能一眼
            看到自己实际要存的是哪一天，而不是只看见三个各自独立的数字 */}
        <Text variant="caption" color="textFaint" style={styles.centerHint}>
          这条记录会记成 {formatDateFull(startedAt)} {formatTime(startedAt)}
        </Text>
      </Card>

      <Text variant="caption" color="textMuted">
        训练名
      </Text>
      <TextInput
        style={styles.nameInput}
        value={name}
        onChangeText={setName}
        placeholder="未命名训练"
        // 占位文字必须跟着主题走，否则浅色主题下会是几乎看不见的白
        placeholderTextColor={palette.textFaint}
        returnKeyType="done"
        maxLength={40}
        accessibilityLabel="训练名"
      />

      <Text variant="caption" color="textMuted">
        时长（分钟）
      </Text>
      <Card style={styles.formCard}>
        <View style={styles.stepperGroup}>
          <Stepper
            label="时长（分钟）"
            value={duration}
            step={DURATION_STEP_MINUTES}
            min={MIN_DURATION_MINUTES}
            onChange={handleDurationChange}
          />
        </View>
      </Card>

      <Text variant="caption" color="textMuted">
        动作
      </Text>
      {rows.map((row, index) => (
        <Card
          key={`${row.exerciseId}-${index}`}
          tone="sunken"
          style={styles.exerciseCard}
        >
          <View style={styles.exerciseHeader}>
            {/* 序号用等宽数字，第 10 个动作不会让名字列左右错开 */}
            <Text variant="numeric" style={styles.exerciseIndex}>
              {index + 1}
            </Text>
            <Text variant="body" style={styles.exerciseName} numberOfLines={1}>
              {row.name}
            </Text>
            <Text variant="numeric" style={styles.exerciseSummary}>
              {row.weight} kg × {row.reps}
            </Text>
            <Pressable
              onPress={() => removeRow(index)}
              accessibilityRole="button"
              accessibilityLabel={`移除动作：${row.name}`}
              style={({ pressed }) => [
                styles.removeButton,
                { opacity: pressed ? 0.5 : 1 },
              ]}
            >
              <Text variant="body" style={styles.removeText}>
                ✕
              </Text>
            </Pressable>
          </View>

          <View style={styles.stepperGroup}>
            {/* 重量 2.5、次数 1，与记录页同一套步长；组数的上限只有这里知道，
                所以夹在回调里（`Stepper` 没有 `max`） */}
            <Stepper
              label="重量"
              value={row.weight}
              step={2.5}
              min={0}
              onChange={(next) => updateRow(index, { weight: next })}
            />
            <Stepper
              label="次数"
              value={row.reps}
              step={1}
              min={1}
              onChange={(next) => updateRow(index, { reps: next })}
            />
            <Stepper
              label="组数"
              value={row.setCount}
              step={1}
              min={1}
              onChange={(next) =>
                updateRow(index, { setCount: clamp(next, 1, MAX_SET_COUNT) })
              }
            />
          </View>
        </Card>
      ))}

      {rows.length === 0 ? (
        <Text variant="caption" color="textFaint" style={styles.centerHint}>
          还没有动作。一场训练至少要有一个动作才存得下来。
        </Text>
      ) : null}

      <Button
        label="＋　添加动作"
        variant="secondary"
        onPress={() => setPickerVisible(true)}
        accessibilityLabel="添加动作"
      />

      {/* 保存走的是与 CSV 导入**同一个** `importWorkouts`，见 `handleSave` */}
      <Button
        label="保存"
        onPress={() => {
          void handleSave();
        }}
        loading={saving}
        loadingLabel="保存中…"
        disabled={saving}
        style={{ marginTop: space.sm }}
      />
    </>
  );

  // CSV 模式当前该显示哪一屏。`preview !== null` 是 `preview` 阶段的必要条件 ——
  // 类型上也靠它把 `CsvPreviewData | null` 收窄成 `CsvPreviewData`
  const csvContent =
    stage === 'preview' && preview !== null
      ? renderCsvPreview(preview)
      : renderCsvIdle();

  return (
    <Screen padded={false}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: space.lg,
          paddingBottom: space.xl,
          gap: space.md,
        }}
        // 训练名输入框还开着时，点「添加动作」或步进器不该被键盘吃掉那一次点击
        keyboardShouldPersistTaps="handled"
      >
        {isManual ? renderManual() : csvContent}
      </ScrollView>

      {/* 动作选择弹层：与记录页、计划编辑页共用同一个组件（三条容易写错的约定
          只有一份实现）。放在 ScrollView 外面，滚动不会影响它 */}
      {isManual ? (
        <ExercisePickerModal
          visible={pickerVisible}
          onClose={() => setPickerVisible(false)}
          onPick={handleAddExercise}
        />
      ) : null}
    </Screen>
  );
}

/**
 * 预览里的一行「标签 + 主文本（+ 次要说明）」。
 *
 * 抽出来是为了让四行的标签宽度与竖向基线**在结构上**一致 —— 复制四遍再各改一处，
 * 迟早会有一行对不齐，而这一屏是给人核对的，错位就是读错。
 *
 * @param props.label 左侧标签
 * @param props.value 右侧主文本
 * @param props.hint 主文本下面的一行小字，没有就不渲染
 * @returns 一行预览信息
 */
function InfoRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const styles = useImportStyles();

  return (
    <View style={styles.infoRow}>
      <Text variant="caption" color="textMuted" style={styles.infoLabel}>
        {label}
      </Text>
      <View style={styles.infoValueBlock}>
        {/* 值可以有第二行（比如「将新建为自定义动作」的名单），标签不会跟着被推走 */}
        <Text variant="body" style={styles.infoValue}>
          {value}
        </Text>
        {hint ? (
          <Text variant="caption" color="textMuted">
            {hint}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * 这一屏用到的全部样式。
 *
 * **写成 hook 而不是模块级的 `StyleSheet.create`**：颜色来自主题，而主题在运行时
 * 才定（跟随系统明暗）。模块级常量在模块加载时就固化了，拿不到主题。
 *
 * 布局类样式（间距、方向、对齐）走 `src/ui` 的 token；只有颜色取自 palette。
 *
 * @returns 绑定了当前主题的样式对象
 */
function useImportStyles() {
  const palette = usePalette();

  return useMemo(
    () => ({
      // 预览的「标签 + 值」行
      infoRow: {
        flexDirection: 'row' as const,
        alignItems: 'flex-start' as const,
        gap: space.md,
      },
      // 定宽标签：几行的值才会落在同一条竖线上
      infoLabel: { width: 64 },
      infoValueBlock: { flex: 1, gap: space.xs },
      infoValue: { flex: 1 },

      // 「读不懂」那一行：标签 + 值 + 展开按钮同一行，展开的明细在下面
      skippedBlock: { gap: space.xs },
      skippedHeader: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: space.md,
      },
      skippedList: { gap: space.xs, paddingTop: space.xs },
      toggleText: { color: palette.accent, fontWeight: weight.medium },

      // 表单
      formCard: { gap: space.md },
      // 步进器排成会自动换行的一排：一个 Stepper 有 176 dp 宽，窄屏上一行放不下
      // 两个，`wrap` 之后也不会溢出屏幕（溢出的话右侧的「＋」会被切掉，按不到）
      stepperGroup: {
        flexDirection: 'row' as const,
        flexWrap: 'wrap' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-around' as const,
        gap: space.md,
      },
      centerHint: { textAlign: 'center' as const },

      nameInput: {
        backgroundColor: palette.surfaceRaised,
        borderRadius: radius.md,
        borderWidth: border.hairline,
        borderColor: palette.border,
        paddingHorizontal: space.md,
        paddingVertical: space.md,
        fontSize: fontSize.title,
        color: palette.text,
      },

      exerciseCard: { gap: space.md },
      exerciseHeader: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: space.sm,
      },
      exerciseIndex: { width: 24, fontSize: fontSize.caption, color: palette.textFaint },
      // 动作名吃掉剩余宽度，右侧的概要与删除按钮才能每行对齐
      exerciseName: { flex: 1, color: palette.text },
      exerciseSummary: { color: palette.textMuted },
      removeButton: {
        width: 36,
        height: 36,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderRadius: radius.sm,
        borderWidth: border.hairline,
        borderColor: palette.border,
        backgroundColor: palette.surfaceRaised,
      },
      removeText: { color: palette.danger },
    }),
    [palette],
  );
}
