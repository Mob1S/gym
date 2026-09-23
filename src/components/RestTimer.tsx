import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

interface RestTimerProps {
  /** 本次休息开始的时间戳（`SetEntry.restStartedAt`） */
  startedAt: number;
  /** 刚完成的那一组的数值，用来给用户一个「我做到哪了」的确认 */
  justCompleted: { weight: number; reps: number };
  onStartNextSet: () => void;
  onSwitchExercise: () => void;
}

/**
 * 毫秒 → `MM:SS`。负数（时钟被回拨）按 0 处理，不做倒计时也不显示负号。
 *
 * @param ms 已经休息了多久，单位毫秒（`Date.now() − startedAt`）
 * @returns 定长的 `MM:SS` 字符串，分和秒都补零。补零是为了让宽度恒定，
 *   再配合样式里的 tabular-nums，秒数从 9 跳到 10 时整块数字不会左右抖
 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 组间休息正计时。
 *
 * **计时口径**：显示值 = `Date.now() − startedAt`，每次 tick 都重新读一次系统
 * 时间。绝不用「每 1000ms 给计数器加 1」的累加写法 —— App 被系统挂起时定时器
 * 会停摆，累加器会漏掉那段时间，而时间戳不会（设计文档全局约束「计时用时间戳」）。
 * 用 250ms 而不是 1000ms 驱动重渲染，是为了让秒数跳变最多迟 250ms，视觉上跟手；
 * `setInterval` 在这里只负责「催渲染」，不参与任何时间运算。
 *
 * 正计时、不设目标、不催人：练多久休息多久是用户自己的事。
 *
 * @param props.startedAt 本次休息开始的时间戳（ms，`SetEntry.restStartedAt`）。
 *   每完成一组就会换一个新值，effect 靠它重新对齐
 * @param props.justCompleted 刚完成那一组的重量（kg）与次数，只用来显示一行
 *   「刚刚完成了什么」的确认文案，不参与计时
 * @param props.onStartNextSet 点「开始下一组」时回调；结束休息、切到下一组的逻辑都在调用方
 * @param props.onSwitchExercise 点「换下一个动作」时回调
 *
 * 交互陷阱：组件自己不结束休息、不写库、不设目标时长，只是把两个按钮的
 * 点击转成回调 —— 谁把 startedAt 清掉，休息才算结束。
 */
export function RestTimer({
  startedAt,
  justCompleted,
  onStartNextSet,
  onSwitchExercise,
}: RestTimerProps) {
  // 只用来「催渲染」的当前时间戳：每次 tick 重新读一次系统时间，
  // 中间漏掉多少 tick 都不影响显示结果（显示值永远是 now − startedAt）。
  const [now, setNow] = useState(() => Date.now());

  // 依赖 startedAt：换一组休息时时间戳变了，必须重新对齐一次，
  // 否则新一组会接着上一组的秒数继续往上走。定时器只在挂载/换组时重建。
  useEffect(() => {
    // 挂载时先对齐一次：本次渲染可能发生在 startedAt 之后很久
    // （比如从后台切回前台、或深链重进这一屏）。
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [startedAt]);

  const elapsed = formatElapsed(now - startedAt);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>组间休息</Text>
      <Text style={styles.clock}>{elapsed}</Text>
      <Text style={styles.justDone}>
        刚刚完成 {justCompleted.weight} kg × {justCompleted.reps}
      </Text>

      <Pressable
        style={styles.primaryButton}
        onPress={onStartNextSet}
        accessibilityLabel="开始下一组"
      >
        <Text style={styles.primaryButtonText}>开始下一组</Text>
      </Pressable>

      <Pressable
        style={styles.linkButton}
        onPress={onSwitchExercise}
        accessibilityLabel="换下一个动作"
      >
        <Text style={styles.link}>或 换下一个动作</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 24,
  },
  label: { fontSize: 13, color: '#8a8f98' },
  // 等宽数字（tabular-nums）：秒数从 9 跳到 10 时宽度不变，整块数字不会左右抖。
  clock: {
    fontSize: 64,
    fontWeight: '800',
    letterSpacing: -2,
    fontVariant: ['tabular-nums'],
  },
  justDone: { fontSize: 13, color: '#8a8f98', marginBottom: 20 },
  primaryButton: {
    backgroundColor: '#2b7fff',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 40,
    alignItems: 'center',
    minWidth: 240,
  },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  linkButton: { padding: 8 },
  link: { color: '#2b7fff', fontSize: 14 },
});
