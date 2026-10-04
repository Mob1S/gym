import { createContext } from 'react';

/**
 * 主题偏好的注入点。
 *
 * **为什么 Context 和 hook 分在两个文件里：** `theme.ts` 要读这个 Context，
 * 而 Context 的定义需要「覆盖值」这个类型；把两者放一起就成了循环 import。
 * 所以类型与 Context 住在这里（**不依赖 `theme.ts` 的任何东西**），
 * `theme.ts` 单向依赖本文件。
 *
 * 另一条边界同样重要：这一层**不知道「设置」这回事** —— 它只有一个
 * `'light' | 'dark' | null` 的值。把「从数据库读用户偏好」留给
 * `store/themePreference.tsx`，视觉层就不必依赖仓储层。
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

/**
 * 一套完整的配色。
 *
 * 定义在这里而不是 `theme.ts`：`Theme` 要用到它，而 `Theme` 又必须住在
 * 本文件（Context 的类型）—— 放 `theme.ts` 会绕成循环 import。
 * 具体的两套配色值仍然在 `theme.ts` 里。
 */
export type Palette = Record<ColorRole, string>;

/**
 * 用户在设置里显式选的主题；`null` = 没选过，跟随系统。
 *
 * 取值与 `repositories/settingsRepo.ts` 的 `ThemeMode` 相呼应，
 * 但去掉了 `'system'` —— 在这里「跟随系统」就是 `null`，
 * 少一个需要判断的分支。
 */
export type ThemeOverride = 'light' | 'dark' | null;

/** `Theme` 的定义。放在这里是为了让 Context 的类型不依赖 `theme.ts` */
export interface Theme {
  /** 当前这套颜色 */
  palette: Palette;
  /** 当前是不是暗色主题 */
  isDark: boolean;
}

/**
 * 当前生效的主题覆盖值。默认 `null`（跟随系统）——
 * 这正是 Provider 缺席时该有的行为，也让单测可以直接渲染组件而不必包 Provider。
 */
export const ThemeOverrideContext = createContext<ThemeOverride>(null);
