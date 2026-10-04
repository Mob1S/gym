import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { usePalette, type ColorRole } from './theme';
import { fontSize, leading, tracking, weight } from './tokens';

/**
 * 统一的文字组件。
 *
 * 全 App 不再直接 import `react-native` 的 `Text` —— 都走这里。原因只有一个：
 * 排版是**成套**的（字号 + 字重 + 行高 + 字距必须匹配），散在各屏幕里手写
 * `fontSize: 17, fontWeight: '600'` 迟早会漂移出七八种「差不多」的标题。
 */

/**
 * 排版变体。
 *
 * `numeric` 与 `display` / `clock` 的区别见下面 `Text` 的注释 —— 凡是会**变**的
 * 数字一律用 `numeric`，这是本 App 数字不跳宽的关键。
 */
export type TextVariant =
  | 'display'
  | 'clock'
  | 'numeric'
  | 'stat'
  | 'h1'
  | 'h2'
  | 'title'
  | 'body'
  | 'caption'
  | 'label';

/** 半粗和粗体在中文里差别不明显，所以只用 regular / medium / bold 三档，见 tokens */
interface VariantStyle {
  fontSize: number;
  fontWeight: '400' | '600' | '800';
  letterSpacing?: number;
  lineHeight?: number;
}

const VARIANT_STYLES: Record<TextVariant, VariantStyle> = {
  // 记录页那个超大重量 / 次数。用等宽数字，拖动时宽度恒定
  display: {
    fontSize: fontSize.display,
    fontWeight: weight.bold,
    letterSpacing: tracking.display,
  },
  // 休息计时的钟面。等宽数字，秒数 9→10 时整块不抖
  clock: {
    fontSize: fontSize.clock,
    fontWeight: weight.bold,
    letterSpacing: tracking.clock,
  },
  // 通用等宽数字：统计值、列表里的重量、历史容量。比 display 小，但同样不跳宽
  numeric: { fontSize: fontSize.title, fontWeight: weight.bold },
  stat: { fontSize: fontSize.stat, fontWeight: weight.bold, letterSpacing: -1 },
  h1: { fontSize: fontSize.h1, fontWeight: weight.bold, letterSpacing: -0.5 },
  h2: { fontSize: fontSize.h2, fontWeight: weight.bold },
  title: { fontSize: fontSize.title, fontWeight: weight.medium },
  body: { fontSize: fontSize.body, fontWeight: weight.regular, lineHeight: leading.normal },
  caption: { fontSize: fontSize.caption, fontWeight: weight.regular, lineHeight: leading.tight },
  // 分组小标题。配 1.2 的字距，中文小字才不糊成一团
  label: { fontSize: fontSize.label, fontWeight: weight.medium, letterSpacing: tracking.label },
};

/** 带主题颜色的 Text 入参 */
export interface TextProps extends RNTextProps {
  /** 排版变体，决定字号 / 字重 / 行高 / 字距 */
  variant?: TextVariant;
  /** 语义色角色。默认 `text`（主文字色） */
  color?: ColorRole;
}

/**
 * 主题化的文字。
 *
 * **什么时候用 `numeric`：** 凡是内容会**变化**的数字都用它 —— 拖动中的重量、
 * 累加的容量、跳动的秒数。它带 `fontVariant: ['tabular-nums']`，每个数字占的
 * 宽度相同，所以 `9 → 10` 不会让整块文字左右挪一下。
 *
 * 固定不变的装饰性数字（比如翻页指示器的 `第 1 / 3 张`）用哪个都行，
 * 但保持一致更省心。
 *
 * @param props.variant 排版变体，默认 `body`
 * @param props.color 颜色角色，默认 `text`
 * @param props.style 额外样式，会覆盖变体里同名的属性
 * @returns 套好主题颜色的文字节点
 */
export function Text({
  variant = 'body',
  color = 'text',
  style,
  ...rest
}: TextProps) {
  const palette = usePalette();
  const numeric = variant === 'numeric';

  return (
    <RNText
      // 等宽数字是这里唯一的「魔法」：它让数字宽度不随内容变化，
      // 而中文字符仍然由系统字体渲染，不必为了数字去背一整套中文字体文件
      style={[
        VARIANT_STYLES[variant],
        numeric ? { fontVariant: ['tabular-nums'] } : null,
        { color: palette[color] },
        style,
      ]}
      {...rest}
    />
  );
}
