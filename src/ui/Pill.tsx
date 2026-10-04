import { Pressable, type ViewStyle } from 'react-native';

import { Text } from './Text';
import { usePalette } from './theme';
import { border, radius, space } from './tokens';

/** `Pill` 的入参 */
export interface PillProps {
  label: string;
  /** 是否选中。选中的用强调色实底 */
  selected?: boolean;
  /** 点击回调。不传就是纯展示的标签，不可点 */
  onPress?: () => void;
  /** 额外样式 */
  style?: ViewStyle;
  /** 无障碍标签 */
  accessibilityLabel?: string;
}

/**
 * 药丸形标签：动作切换条、筛选器。
 *
 * 选中态用**强调色实底 + 近黑文字**，未选中用带描边的表面块。两者的区别不只是
 * 颜色深浅 —— 形状、边界、文字色三个维度同时变，扫一眼就能分辨，不必凑近看色差。
 *
 * @param props.label 标签文字
 * @param props.selected 是否选中
 * @param props.onPress 点击回调；省略则渲染成不可点的静态标签
 * @param props.style 额外样式
 * @param props.accessibilityLabel 无障碍标签，默认取 `label`
 * @returns 药丸标签
 */
export function Pill({
  label,
  selected = false,
  onPress,
  style,
  accessibilityLabel,
}: PillProps) {
  const palette = usePalette();

  const body = (
    <Text
      variant="caption"
      numberOfLines={1}
      style={{
        fontWeight: '600',
        color: selected ? palette.onAccent : palette.textMuted,
      }}
    >
      {label}
    </Text>
  );

  const containerStyle: ViewStyle = {
    backgroundColor: selected ? palette.accent : palette.surfaceRaised,
    borderColor: selected ? palette.accent : palette.border,
    borderWidth: border.hairline,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    // 长动作名不能把整条撑爆，超出部分交给 numberOfLines 截断
    maxWidth: 180,
    ...style,
  };

  if (!onPress) return <Pressable style={containerStyle}>{body}</Pressable>;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      style={({ pressed }) => [containerStyle, { opacity: pressed ? 0.7 : 1 }]}
    >
      {body}
    </Pressable>
  );
}
