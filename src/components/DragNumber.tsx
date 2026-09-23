import * as Haptics from 'expo-haptics';
import { useMemo, useRef } from 'react';
import {
  PanResponder,
  StyleSheet,
  Text,
  View,
  type PanResponderGestureState,
} from 'react-native';

/**
 * 每拖动这么多像素，数值变化一档。
 *
 * 12px 是「手指随便动一下不会跳档、从上滑到下能明显改变数值」之间的折中：
 * 一档 2.5 kg 意味着整屏高度大约覆盖 50 kg，正好是一台器械的配重区间。
 */
const PIXELS_PER_STEP = 12;

interface DragNumberProps {
  /** 显示在数字下方的小字，例如「重量」 */
  label: string;
  /** 显示在数字右侧的单位，例如「kg」；次数没有单位 */
  unit?: string;
  value: number;
  /** 一档变化多少（重量 2.5，次数 1） */
  step: number;
  /** 拖动下限（重量 0，次数 1） */
  min: number;
  /** 每次数值变化都会回调，拖动过程中连续触发 */
  onChange: (next: number) => void;
}

/**
 * 把浮点步进的结果按 step 的小数位收干净，避免出现 22.500000000000004
 *
 * @param value 原始计算结果（按下时的基准值 + 档数 × step）
 * @param step 步长，用它的小数位数决定收几位：2.5 收 1 位、1 收 0 位
 * @returns 收干净后的值。不收敛的话 `0.1 + 0.2` 这类二进制误差会直接在
 *   大数字上显示出来，而拖动时这个字符串每帧都在变，看着像数字在抖
 */
function roundToStep(value: number, step: number): number {
  const decimals = (step.toString().split('.')[1] ?? '').length;
  if (decimals === 0) return Math.round(value);
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * 把横向拖动距离换算成「跳了几档」。
 *
 * @param gestureState PanResponder 交给回调的手势状态，这里只用到 `dx`
 *   （相对按下点的横向位移，单位 px，往右为正）
 * @returns 跳档数，四舍五入到整数；负数是往左拖（减），0 表示还没拖出一档
 */
function stepCount(gestureState: PanResponderGestureState): number {
  return Math.round(gestureState.dx / PIXELS_PER_STEP);
}

/**
 * 可左右拖动调值的大数字。
 *
 * 用 React Native **内置的 PanResponder**，不引入 `react-native-gesture-handler`：
 * 根布局没有包 `GestureHandlerRootView`，直接用手势库会在真机上崩。
 *
 * 两个关键取舍：
 * 1. **只在横向位移超过阈值时才接手手势**（`onMoveShouldSetPanResponder`），
 *    纵向拖动仍然留给外层列表滚动。
 * 2. **`onPanResponderTerminationRequest` 恒返回 false** —— 一旦开始拖就绝不把
 *    手势让给别人。否则手指稍一停顿，外层可滚动容器会抢走手势，拖动中断，
 *    而此时若手指恰好抬在「完成这组」上，就会误记一组。
 *
 * @param props.label 数字下方的小字，例如「重量」
 * @param props.unit 数字右侧的单位，例如「kg」；次数没有单位，不传
 * @param props.value 当前值（重量 kg 或次数），受控值
 * @param props.step 每档变化量，重量 2.5、次数 1
 * @param props.min 拖动下限，重量 0、次数 1；到下限后继续往左拖也不会再减
 * @param props.onChange 每变化一档就回调一次。注意是**拖动过程中连续触发**、
 *   不是在松手时触发，所以调用方不要在这里做写库这类重活，否则每档都掉帧
 *
 * 交互陷阱：点一下不改值（`onStartShouldSetPanResponder` 返回 false），
 * 只有横向位移超过 4px 才接手手势 —— 所以「轻点数字」在宿主界面里
 * 仍然是普通点击，可以安全地把这个组件放在按钮旁边。
 */
export function DragNumber({
  label,
  unit,
  value,
  step,
  min,
  onChange,
}: DragNumberProps) {
  // 手势回调只在创建时绑定一次，所以最新的入参一律从 ref 里读，
  // 否则拖到一半父组件重渲染就会用到陈旧的 value/step。
  // 因此下面这几行赋值必须留在每次渲染都执行的位置，搬进 effect 或加依赖判断都会晚一拍。
  const valueRef = useRef(value);
  valueRef.current = value;
  const stepRef = useRef(step);
  stepRef.current = step;
  const minRef = useRef(min);
  minRef.current = min;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  /** 手指按下时的数值。整段拖动都相对这个基准计算，不做累加，避免误差堆积。 */
  const startValue = useRef(0);

  // 手势配置只建一次（依赖数组是空的）。拖到一半重建 PanResponder 会丢掉当前
  // 手势，表现就是数值拖到一半突然不动了；最新入参靠上面那组 ref 拿。
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // 按下时不抢手势：点一下（比如点空白处）不该改数值。
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 4,
        onPanResponderGrant: () => {
          startValue.current = valueRef.current;
        },
        onPanResponderMove: (_e, g) => {
          const step = stepRef.current;
          const next = Math.max(
            minRef.current,
            roundToStep(startValue.current + stepCount(g) * step, step),
          );
          if (next === valueRef.current) return;
          // 先更新 ref 再回调：拖动过程中父组件是异步 setState，
          // value 这个 prop 会晚一拍才回来，靠 ref 去重才能每档只振一次。
          valueRef.current = next;
          onChangeRef.current(next);
          try {
            void Haptics.selectionAsync();
          } catch {
            // 无振动马达的设备上忽略
          }
        },
        // 松手即定格：数值在 move 里已经写回父组件，这里不再改值。
        onPanResponderRelease: () => {},
        onPanResponderTerminate: () => {},
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );

  return (
    <View
      style={styles.zone}
      accessibilityLabel={`${label} ${value}${unit ?? ''}，左右拖动调整`}
      {...panResponder.panHandlers}
    >
      <View style={styles.row}>
        <Text style={styles.number}>{value}</Text>
        {unit ? <Text style={styles.unit}>{unit}</Text> : null}
      </View>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // 没有背景、没有边框：这一块是靠手势生效的「隐形」热区，
  // 加任何可见的拖动把手都会在这块大数字上添乱。
  zone: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  number: { fontSize: 64, fontWeight: '800', letterSpacing: -2 },
  unit: { fontSize: 20, fontWeight: '600', color: '#8a8f98' },
  label: { fontSize: 12, color: '#8a8f98' },
});
