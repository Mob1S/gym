import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '../ui/Text';
import { usePalette } from '../ui/theme';
import { border, radius, space } from '../ui/tokens';

interface StepperProps {
  label: string;
  value: number;
  step: number;
  min: number;
  onChange: (next: number) => void;
}

/**
 * 加减步进器。
 *
 * 器械上的最小配重片通常就是 2.5 kg，所以重量用 2.5 的步长、次数用 1 的步长，
 * 都由调用方通过 `step` 指定。按钮做到 52×52，是因为这是手指能稳定点中的
 * 最小尺寸 —— 这个界面是单手在健身房点的，不是坐在桌前点的。
 *
 * **它和大数字拖动是互补的，不是重复的**：拖动适合大跨度调整（20 → 60），
 * 但手上有汗时容易滑过头；步进器负责精确微调，是这个场景下的必要退路。
 * 所以视觉上把它做得**明显次级**（小字号、低对比），避免和上面的大数字抢注意力。
 *
 * @param props.label 数字上方的说明文字（如「重量」），同时拼进无障碍标签「增加重量」
 * @param props.value 当前值，重量是 kg、次数是个数；组件自己不存值，只显示
 * @param props.step 点一次增减多少，重量 2.5、次数 1
 * @param props.min 下限，重量传 0、次数传 1
 * @param props.onChange 点一下立刻回传新值，没有防抖 —— 写库时机由调用方决定
 *
 * 交互陷阱：只有下限、没有上限。不同器械的最大配重差得很远，
 * 卡一个硬上限反而会挡住少数大重量器械，所以到顶了也让用户继续加。
 */
export function Stepper({ label, value, step, min, onChange }: StepperProps) {
  const palette = usePalette();

  /** 减一档。夹住下限，否则重量会减成负数、次数会减到 0。 */
  const decrease = () => onChange(Math.max(min, value - step));
  /** 加一档。不设上限，理由见组件注释最后一段。 */
  const increase = () => onChange(value + step);

  /**
   * 一个 +/− 按钮。
   *
   * 抽成内部组件只是为了让两个按钮的样式**在结构上**不可能漂移 —— 复制一份
   * 出来改一处忘一处，两个按钮就会长得不一样。
   *
   * @param props.onPress 点击回调
   * @param props.sign 显示的符号
   * @param props.accessibilityLabel 无障碍标签
   * @returns 方形的加减按钮
   */
  const renderButton = (
    onPress: () => void,
    sign: string,
    accessibilityLabel: string,
  ) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: pressed ? palette.border : palette.surfaceRaised,
          borderColor: palette.border,
        },
      ]}
    >
      <Text variant="h2" color="textMuted">
        {sign}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.wrapper}>
      <Text variant="label" color="textFaint">
        {label}
      </Text>
      <View style={styles.row}>
        {renderButton(decrease, '−', `减少${label}`)}
        <Text variant="numeric" color="textMuted" style={styles.value}>
          {value}
        </Text>
        {renderButton(increase, '＋', `增加${label}`)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { alignItems: 'center', gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  button: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    borderWidth: border.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 定宽 + 居中：数值从 9 变到 10 时按钮不会跟着挪位
  value: { minWidth: 56, textAlign: 'center', fontSize: 18 },
});
