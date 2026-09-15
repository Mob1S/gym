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
 */
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
