import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, View } from 'react-native';

import { Button } from '../ui/Button';
import { Text } from '../ui/Text';
import { usePalette } from '../ui/theme';
import { space } from '../ui/tokens';

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

/** 指示点的呼吸周期。1.6 秒接近平静呼吸，快了会显得焦躁，而这屏的基调是「不催人」 */
const PULSE_DURATION_MS = 1600;

/**
 * 组间休息正计时。
 *
 * **计时口径**：显示值 = `Date.now() − startedAt`，每次 tick 都重新读一次系统
 * 时间。绝不用「每 1000ms 给计数器加 1」的累加写法 —— App 被系统挂起时定时器
 * 会停摆，累加器会漏掉那段时间，而时间戳不会（设计文档全局约束「计时用时间戳」）。
 * 用 250ms 而不是 1000ms 驱动重渲染，是为了让秒数跳变最多迟 250ms，视觉上跟手；
 * `setInterval` 在这里只负责「催渲染」，不参与任何时间运算。
 *
 * 正计时、不设目标、不催人：练多久休息多久是用户自己的事。钟面旁边那个呼吸的
 * 小点只有一个作用 —— 证明「它真的在走」。静止的 `00:00` 分不出「刚开始休息」
 * 和「计时挂了」，一个会呼吸的点能，而且它不设目标、不催促。
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
  const palette = usePalette();

  // 只用来「催渲染」的当前时间戳：每次 tick 重新读一次系统时间，
  // 中间漏掉多少 tick 都不影响显示结果（显示值永远是 now − startedAt）。
  const [now, setNow] = useState(() => Date.now());

  // 呼吸指示点的透明度。用内置 Animated + useNativeDriver，
  // 不引 reanimated 的动画 API（那套在 web 预览下的行为还要额外验证）
  const pulse = useRef(new Animated.Value(1)).current;

  // 依赖 startedAt：换一组休息时时间戳变了，必须重新对齐一次，
  // 否则新一组会接着上一组的秒数继续往上走。定时器只在挂载/换组时重建。
  useEffect(() => {
    // 挂载时先对齐一次：本次渲染可能发生在 startedAt 之后很久
    // （比如从后台切回前台、或深链重进这一屏）。
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [startedAt]);

  // 呼吸动画单独一个 effect，只建一次。
  // **必须尊重系统的「减弱动态效果」**：这个偏好是前庭功能障碍用户设定的，
  // 忽略它可能直接让人不适。读一次初值即可，不必监听后续变化 —— 休息只有几分钟。
  useEffect(() => {
    let animation: Animated.CompositeAnimation | null = null;
    let cancelled = false;

    void AccessibilityInfo.isReduceMotionEnabled().then((reduceMotion) => {
      if (cancelled || reduceMotion) return;
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 0.25,
            duration: PULSE_DURATION_MS / 2,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 1,
            duration: PULSE_DURATION_MS / 2,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      );
      animation.start();
    });

    return () => {
      cancelled = true;
      animation?.stop();
    };
  }, [pulse]);

  const elapsed = formatElapsed(now - startedAt);

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.sm,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
        }}
      >
        {/* 会呼吸的点 = 「正在计时」。这是全 App 仅有的两处动效之一 */}
        <Animated.View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: palette.accent,
            opacity: pulse,
          }}
        />
        <Text variant="label" color="textMuted">
          组间休息
        </Text>
      </View>

      <Text variant="clock">{elapsed}</Text>

      <Text
        variant="caption"
        color="textMuted"
        style={{ marginBottom: space.xl }}
      >
        刚刚完成 {justCompleted.weight} kg × {justCompleted.reps}
      </Text>

      <Button
        label="开始下一组"
        onPress={onStartNextSet}
        accessibilityLabel="开始下一组"
      />

      <Button
        label="或 换下一个动作"
        variant="ghost"
        onPress={onSwitchExercise}
        accessibilityLabel="换下一个动作"
        style={{ marginTop: space.sm }}
      />
    </View>
  );
}
