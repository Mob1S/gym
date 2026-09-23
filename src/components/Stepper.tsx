import { Pressable, StyleSheet, Text, View } from 'react-native';

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
 * 都由调用方通过 `step` 指定。按钮做到 44×44，是因为这是手指能稳定点中的
 * 最小尺寸 —— 这个界面是单手在健身房点的，不是坐在桌前点的。
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
  /** 减一档。夹住下限，否则重量会减成负数、次数会减到 0。 */
  const decrease = () => onChange(Math.max(min, value - step));
  /** 加一档。不设上限，理由见组件注释最后一段。 */
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
