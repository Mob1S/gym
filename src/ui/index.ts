/**
 * 视觉层的唯一入口。
 *
 * 界面只从 `src/ui` 取样式与基础组件，不直接碰 `react-native` 的 `Text`、也不写
 * 颜色字面量。这一层**不含任何业务逻辑、不访问数据库、不持有状态** ——
 * 它只回答「长什么样」。
 */

export { Text, type TextProps, type TextVariant } from './Text';
export {
  Screen,
  TabBarHeightProvider,
  type ScreenProps,
} from './Screen';
export { Card, type CardProps } from './Card';
export { Button, type ButtonProps, type ButtonVariant } from './Button';
export { Pill, type PillProps } from './Pill';
export { StatTile, type StatTileProps } from './StatTile';
export {
  DumbbellIcon,
  ClockIcon,
  TrendIcon,
  GearIcon,
  type IconProps,
} from './icons';

export {
  useTheme,
  usePalette,
  statusBarStyle,
  darkPalette,
  lightPalette,
  type Palette,
  type ColorRole,
  type Theme,
} from './theme';

export {
  space,
  radius,
  border,
  fontSize,
  weight,
  tracking,
  leading,
} from './tokens';
