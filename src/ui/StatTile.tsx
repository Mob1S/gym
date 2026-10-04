import { View, type ViewStyle } from 'react-native';

import { Text } from './Text';
import { usePalette } from './theme';
import { radius, space } from './tokens';

/** `StatTile` 的入参 */
export interface StatTileProps {
  /** 主数字，已格式化好的字符串。数字类内容请传字符串，交给调用方决定保留几位 */
  value: string;
  /** 数字下方的说明，如「总组数」 */
  label: string;
  /** 数字右侧的单位，如 `kg`。与 `label` 二选一，不要同时用 */
  unit?: string;
  /**
   * 是否用强调色显示数字。
   *
   * 一排三个统计块里，至多让一个用强调色 —— 全都强调等于全都不强调。
   */
  emphasized?: boolean;
  /** 额外样式 */
  style?: ViewStyle;
}

/**
 * 统计数字块：一个大数字 + 一行说明。
 *
 * 数字用 `stat` 变体（等宽，字号 30），说明用 `label` 变体。这个大小关系是
 * 刻意的 —— 看统计块的人要的是数字，说明只是让数字有意义。
 *
 * @param props.value 主数字
 * @param props.label 说明文字
 * @param props.unit 单位，显示在数字右侧
 * @param props.emphasized 数字是否用强调色
 * @param props.style 额外样式
 * @returns 统计块
 */
export function StatTile({
  value,
  label,
  unit,
  emphasized = false,
  style,
}: StatTileProps) {
  const palette = usePalette();

  return (
    <View
      style={[
        {
          flex: 1,
          backgroundColor: palette.surface,
          borderRadius: radius.md,
          paddingVertical: space.md,
          paddingHorizontal: space.sm,
          alignItems: 'center',
          gap: space.xs,
        },
        style,
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 2 }}>
        <Text
          variant="numeric"
          numberOfLines={1}
          // 大数字的等宽特性在这里同样重要：时长从 59 变到 60 时不该把说明文字挤走
          style={{
            fontSize: 30,
            color: emphasized ? palette.accent : palette.text,
          }}
        >
          {value}
        </Text>
        {unit ? (
          <Text variant="caption" color="textMuted">
            {unit}
          </Text>
        ) : null}
      </View>
      <Text variant="label" color="textMuted">
        {label}
      </Text>
    </View>
  );
}
