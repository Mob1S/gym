import type { SqlExecutor } from '../db/types';

/**
 * 用户偏好设置的读写。
 *
 * 底层是 `app_setting` 这张键值表（schema 版本 2 引入）。这一层只负责
 * 「把字符串存进去、读出来」，**不解释值的含义** —— 每个键的合法取值由使用它的
 * 那个模块自己定义并校验，这样加新设置时不必动这里。
 */

/**
 * 主题模式在 `app_setting` 里的键名。
 *
 * 英文键名：既有代码里的键（`schema_version`）就是英文，保持一致。
 */
export const THEME_MODE_KEY = 'theme_mode';

/**
 * 主题模式。
 *
 * **三态而不是布尔。** 布尔（深色/浅色）表达不了「跟随系统」—— 那才是默认行为，
 * 也是大多数用户想要的。用户一进设置页看到的是「跟随系统」被选中，
 * 而不是被迫在两种颜色里挑一个。
 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 全部合法取值，同时也是设置页里按钮的顺序 */
export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

/**
 * 判断一个任意字符串是不是合法的主题模式。
 *
 * **必须校验而不是直接断言。** 这个值来自数据库，可能是旧版本写的、
 * 手改的、或将来某个版本改过语义的。把它当 `ThemeMode` 直接用的后果是
 * 界面拿到一个不存在的配色分支，表现为白屏或颜色错乱。
 *
 * @param value 从库里读出来的原始字符串
 * @returns 是合法主题模式时为 true，同时把类型收窄
 */
export function isThemeMode(value: string): value is ThemeMode {
  return (THEME_MODES as readonly string[]).includes(value);
}

/**
 * 读一个设置项。
 *
 * @param exec SQL 执行器
 * @param key 键名
 * @returns 值；**键不存在时返回 null**（不是空串 —— 空串是一个合法的、被显式
 *          写入过的值，两者必须能区分）
 */
export async function getSetting(
  exec: SqlExecutor,
  key: string,
): Promise<string | null> {
  const row = await exec.first<{ value: string }>(
    'SELECT value FROM app_setting WHERE key = ?',
    [key],
  );
  return row ? row.value : null;
}

/**
 * 写一个设置项。键已存在则覆盖。
 *
 * 用 `ON CONFLICT ... DO UPDATE` 而不是「先删再插」：后者在两个 await 之间
 * 被打断会留下「键没了」的中间状态，而这个键丢了界面会退回默认主题，
 * 用户看到的是自己刚设的偏好莫名消失。
 *
 * @param exec SQL 执行器
 * @param key 键名
 * @param value 值
 */
export async function setSetting(
  exec: SqlExecutor,
  key: string,
  value: string,
): Promise<void> {
  await exec.run(
    `INSERT INTO app_setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/**
 * 读主题模式。
 *
 * @param exec SQL 执行器
 * @returns 用户选过的主题模式；**没设置过、或库里存的是个非法值时一律返回
 *          `'system'`**。非法值不当错误抛出：主题读不出来不该让整个 App 起不来，
 *          退回默认跟随系统是唯一合理的降级
 */
export async function getThemeMode(exec: SqlExecutor): Promise<ThemeMode> {
  const stored = await getSetting(exec, THEME_MODE_KEY);
  if (stored === null) return 'system';
  return isThemeMode(stored) ? stored : 'system';
}

/**
 * 存主题模式。
 *
 * @param exec SQL 执行器
 * @param mode 要保存的主题模式
 */
export async function setThemeMode(
  exec: SqlExecutor,
  mode: ThemeMode,
): Promise<void> {
  await setSetting(exec, THEME_MODE_KEY, mode);
}
