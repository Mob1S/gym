import { useColorScheme } from 'react-native';

/**
 * 全部颜色都在这个文件里，而且只有这个文件里有颜色。
 *
 * 判断标准很简单：源码里不该再出现 `#` 开头的十六进制字面量（grep 得到的结果
 * 应该只有本文件）。这样换配色是改一处，而不是摸遍十一个屏幕。
 */

/**
 * 一套主题需要的全部颜色。
 *
 * `Record<ColorRole, string>` 而不是 `as const` 的字面量类型：两套主题必须
 * 提供**完全相同**的键，少一个就编译不过 —— 这是这套结构唯一的、也是最重要的作用。
 */
export type ColorRole =
  // 背景与表面：靠亮度差分层，不靠边框
  | 'bg'
  | 'surface'
  | 'surfaceRaised'
  | 'surfaceSunken'
  // 强调与语义
  | 'accent'
  | 'onAccent'
  | 'accentMuted'
  | 'success'
  | 'danger'
  | 'onDanger'
  // 文字三层
  | 'text'
  | 'textMuted'
  | 'textFaint'
  // 线条
  | 'border'
  | 'borderStrong';

/** 一套完整的配色 */
export type Palette = Record<ColorRole, string>;

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

/** `useTheme()` 的返回值 */
export interface Theme {
  /** 当前这套颜色 */
  palette: Palette;
  /** 当前是不是暗色主题。状态栏图标方向、图表明暗这类判断要用它 */
  isDark: boolean;
}

/**
 * 取当前主题。
 *
 * 跟随系统（`app.json` 里 `userInterfaceStyle: "automatic"`）。系统主题在
 * 运行中改变时，这个 hook 会让用到它的组件重新渲染 —— 不需要重启 App。
 *
 * 绝大多数组件只关心颜色，用 `usePalette()` 更省事；只有需要区分明暗的少数
 * 地方（状态栏、图表）才用这个。
 *
 * @returns 当前配色与明暗标记。系统未报告主题（极少数情况）时按暗色处理 ——
 *   这是健身场景下的默认假设，也是本 App 的设计基准主题
 */
export function useTheme(): Theme {
  const scheme = useColorScheme();
  const isDark = scheme !== 'light';
  return { palette: isDark ? darkPalette : lightPalette, isDark };
}

/**
 * 只要颜色的简写。
 *
 * @returns 当前配色
 */
export function usePalette(): Palette {
  return useTheme().palette;
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
