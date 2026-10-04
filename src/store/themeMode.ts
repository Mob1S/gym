import type { ThemeMode } from '../repositories/settingsRepo';
import type { ThemeOverride } from '../ui/themeContext';

/**
 * 主题「设置词汇」与「配色词汇」之间的翻译。
 *
 * **独立成一个纯模块是有原因的**：这是两套词汇唯一的接触点 ——
 * 设置里是三态（`system` / `light` / `dark`），配色只认两态加一个「没选」（`null`）。
 * 这个映射弄错了最难查：界面不报错，只是「选了浅色却还是深色」。
 *
 * 放在 `.ts` 而不是 `.tsx` 里，是为了让它能被单元测试直接 import：
 * 本项目的 jest 只配了 `*.test.ts` 与 `@babel/preset-typescript`（没有 JSX 预设），
 * 带 JSX 的文件在测试里根本解析不了。纯逻辑留在 `.tsx` 里等于测不到。
 */

/**
 * 把 `ThemeMode`（三态，含 `'system'`）翻译成 `ThemeOverride`（两态 + null）。
 *
 * @param mode 用户在设置里选的模式
 * @returns 给 `useTheme()` 用的覆盖值；`'system'` 映射为 `null`
 */
export function toThemeOverride(mode: ThemeMode): ThemeOverride {
  // 只有 'system' 表示「没选」。'light' / 'dark' 都是显式选择，必须原样传下去 ——
  // 把 'light' 也当成「没选」的话，在深色手机上选浅色会毫无反应
  if (mode === 'system') return null;
  return mode;
}
