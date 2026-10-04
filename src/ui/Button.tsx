import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';

import { Text } from './Text';
import { usePalette, type ColorRole } from './theme';
import { border, radius, space, weight } from './tokens';

/** 按钮的四种语义 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** `Button` 的入参 */
export interface ButtonProps {
  label: string;
  onPress: () => void;
  /** 语义变体，默认 `primary` */
  variant?: ButtonVariant;
  /** 禁用。配合 `loading` 用可以避免重复提交 */
  disabled?: boolean;
  /** 显示转圈并自动禁用。文案由 `loadingLabel` 决定 */
  loading?: boolean;
  /** 加载中的文案。不传就继续显示 `label` */
  loadingLabel?: string;
  /** 次要说明文字，显示在按钮文案下方（如「继续训练」下面的动作预览） */
  detail?: string;
  /** 是否撑满宽度，默认 `true`。药丸型的小按钮传 false */
  fullWidth?: boolean;
  /** 额外样式 */
  style?: ViewStyle;
  /** 无障碍标签。不传则用 `label` */
  accessibilityLabel?: string;
}

/**
 * 每个变体各部位的配色。
 *
 * 集中成一张表而不是在 JSX 里写三元表达式：四种变体 × 三种部位 = 十二种组合，
 * 散在标签里没人能一眼看全。
 */
const VARIANT_COLORS: Record<
  ButtonVariant,
  { bg: ColorRole; fg: ColorRole; border: ColorRole | null }
> = {
  // 主操作：橙底近黑字。整屏只该有一个
  primary: { bg: 'accent', fg: 'onAccent', border: null },
  // 次级操作：有边界的表面块，不抢主操作的注意力
  secondary: { bg: 'surfaceRaised', fg: 'text', border: 'borderStrong' },
  // 第三级：只有文字，用在「结束训练」这类低频且不该被误点的操作上
  ghost: { bg: 'surface', fg: 'textMuted', border: 'border' },
  // 破坏性操作：导入备份这类会覆盖数据的
  danger: { bg: 'danger', fg: 'onDanger', border: null },
};

/**
 * 主题化按钮。
 *
 * 高度做到 56，比 Material 建议的 48 更高：这个 App 是在健身房里单手、可能戴手套、
 * 手心有汗的情况下点的，点击目标越大越不容易出错。
 *
 * @param props.label 按钮文案
 * @param props.onPress 点击回调
 * @param props.variant 语义变体，默认 `primary`
 * @param props.disabled 是否禁用
 * @param props.loading 是否显示加载中（会自动禁用）
 * @param props.loadingLabel 加载中的文案
 * @param props.detail 文案下方的次要说明
 * @param props.fullWidth 是否撑满宽度，默认是
 * @param props.style 额外样式
 * @param props.accessibilityLabel 无障碍标签，默认取 `label`
 * @returns 可点击的按钮
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  loadingLabel,
  detail,
  fullWidth = true,
  style,
  accessibilityLabel,
}: ButtonProps) {
  const palette = usePalette();
  const colors = VARIANT_COLORS[variant];
  // 加载中也算禁用：否则「导出中…」还能被再点一次
  const inactive = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: palette[colors.bg],
          borderColor: colors.border ? palette[colors.border] : 'transparent',
          borderWidth: colors.border ? border.hairline : 0,
          // 按下时轻微变淡而不是换色：换色在暗色主题下容易看成两个不同的按钮
          opacity: inactive ? 0.5 : pressed ? 0.85 : 1,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        style,
      ]}
    >
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator size="small" color={palette[colors.fg]} />
        ) : null}
        <Text
          variant="title"
          style={{ color: palette[colors.fg], fontWeight: weight.bold }}
        >
          {loading && loadingLabel ? loadingLabel : label}
        </Text>
        {detail ? (
          <Text
            variant="caption"
            style={{ color: palette[colors.fg], opacity: 0.75 }}
            numberOfLines={2}
          >
            {detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    minHeight: 56,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    justifyContent: 'center',
  },
  content: { alignItems: 'center', gap: space.xs },
});
