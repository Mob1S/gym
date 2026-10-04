import { useContext } from 'react';
import { useColorScheme } from 'react-native';

import {
  ThemeOverrideContext,
  type ColorRole,
  type Palette,
  type Theme,
  type ThemeOverride,
} from './themeContext';

/**
 * 全部颜色都在这个文件里，而且只有这个文件里有颜色。
 *
 * 判断标准很简单：源码里不该再出现 `#` 开头的十六进制字面量（grep 得到的结果
 * 应该只有本文件）。这样换配色是改一处，而不是摸遍十一个屏幕。
 */

// `Theme` / `ThemeOverride` / `Palette` / `ColorRole` 这几个类型定义在
// `themeContext.ts`（Context 需要它们，而 `themeContext` 不能反过来依赖本文件）。
// 这里原样再导出，让使用方只认 `src/ui` 一个入口，不必知道它们住在哪个文件。
export type { ColorRole, Palette, Theme, ThemeOverride };

/**
 * 暗色主题（基准主题）。
 *
 * 铸铁近黑打底 + 信号橙做强调。刻意避开的两条路：`#2b7fff` 蓝（AI 生成界面的
 * 最典型特征）、荧光绿（与健身房「绿色 = 安全」的语义冲突）。
 *
 * 背景不用纯黑：纯黑在 OLED 上和深色卡片糊成一片，分不出层级。
 */
export const darkPalette: Palette = {
  // 近黑，但每一级都能看出区别
  bg: '#0B0C0E',
  surface: '#141619',
  surfaceRaised: '#1C1F24',
  surfaceSunken: '#08090B',

  // 信号橙：杠铃片、警示带、力量器械的颜色
  accent: '#FF6A1A',
  // 橙底上的文字用近黑，比白色对比度更高、也更「工业」
  onAccent: '#0B0C0E',
  // 强调色的低饱和铺底，用于选中态的底、图表填充
  accentMuted: '#3A1D0A',
  success: '#32D74B',
  danger: '#FF453A',
  onDanger: '#0B0C0E',

  text: '#F2F4F7',
  textMuted: '#9BA1AC',
  textFaint: '#656B76',

  border: '#2A2E35',
  borderStrong: '#3A3F47',
};

/**
 * 浅色主题：同色相映射，不是把暗色反过来。
 *
 * 简单反色会让橙色在白底上失去对比度，所以浅色的强调色比暗色深一档
 * （`#E4580A`），保证小字号下的可读性。背景用暖白而非纯白，和橙色同属暖调。
 */
export const lightPalette: Palette = {
  bg: '#FAFAF8',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#F0F0EC',

  // 加深一档的信号橙：同一色相，但在白底上有足够对比度
  accent: '#E4580A',
  onAccent: '#FFFFFF',
  accentMuted: '#FDEBDD',
  success: '#1E9E36',
  danger: '#D93025',
  onDanger: '#FFFFFF',

  text: '#16181D',
  textMuted: '#5B6169',
  textFaint: '#8A9099',

  border: '#E3E4E0',
  borderStrong: '#CBCCC7',
};

/**
 * 取当前主题。
 *
 * 优先级：**显式传入 > Provider 注入 > 系统主题**。
 *
 * 绝大多数调用方什么都不用传：`ThemePreferenceProvider` 会把用户在设置里选的值
 * 注入到 Context，`useTheme()` 自己读出来。显式传参只用于那种需要绕过当前偏好、
 * 强制渲染某套配色的地方（目前还没有，留着是为了让这个 hook 单独可测）。
 *
 * 三种来源都是响应式的：系统主题在运行中改变时 `useColorScheme()` 会让组件重渲染，
 * 用户改设置时 Provider 的 state 变化也会 —— 都不需要重启 App。
 *
 * @param override 显式指定的主题；省略时用 Provider 注入的值，再没有就跟随系统
 * @returns 当前配色与明暗标记。系统未报告主题（极少数情况）时按暗色处理 ——
 *   这是健身场景下的默认假设，也是本 App 的设计基准主题
 */
export function useTheme(override?: ThemeOverride): Theme {
  const scheme = useColorScheme();
  const injected = useContext(ThemeOverrideContext);
  // `override` 显式给了就用它（含「显式传 null 表示跟随系统」）；
  // 没给才用 Provider 注入的
  const effective = override === undefined ? injected : override;

  // 显式选择优先；没有选择才看系统。系统只报 'light' / 'dark'，
  // 报不出（null）时按暗色 —— 本 App 的设计基准主题
  const isDark = effective === null ? scheme !== 'light' : effective === 'dark';

  return { palette: isDark ? darkPalette : lightPalette, isDark };
}

/**
 * 只要颜色的简写。
 *
 * @param override 显式指定的主题；见 `useTheme`
 * @returns 当前配色
 */
export function usePalette(override?: ThemeOverride): Palette {
  return useTheme(override).palette;
}

/**
 * 状态栏图标该用亮色还是暗色。
 *
 * 和配色正好相反：暗色背景要浅色图标（`light`），浅色背景要深色图标（`dark`）。
 *
 * @param isDark 当前是不是暗色主题
 * @returns `expo-status-bar` 的 style 值
 */
export function statusBarStyle(isDark: boolean): 'light' | 'dark' {
  return isDark ? 'light' : 'dark';
}
