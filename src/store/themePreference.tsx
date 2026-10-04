import { createContext, useCallback, useContext, useEffect, useState,
  type ReactNode,
} from 'react';
import { ActivityIndicator, View } from 'react-native';

import { getThemeMode, setThemeMode, type ThemeMode } from '../repositories/settingsRepo';
import { useDatabase } from '../repositories/database';
import { ThemeOverrideContext } from '../ui/themeContext';
import { toThemeOverride } from './themeMode';

/**
 * 主题偏好的读写与会话状态。
 *
 * 这一层是「用户偏好」和「视觉层」之间的桥：
 * - 向下，它用 `settingsRepo` 把偏好存进 `app_setting` 表（重启后还在）；
 * - 向上，它把偏好翻译成 `ThemeOverride` 注入 `ThemeOverrideContext`，
 *   让整个 App 的 `useTheme()` / `usePalette()` 都跟着变。
 *
 * 放在 `store/` 而不是 `ui/` 是有意的：`src/ui` 是纯视觉层，不该知道
 * 「设置存在数据库里」这件事。它只认一个 `'light' | 'dark' | null` 的值。
 */

/** 主题偏好的上下文内容 */
interface ThemePreferenceValue {
  /** 用户当前选的模式（含「跟随系统」） */
  mode: ThemeMode;
  /**
   * 切换模式。会先改内存状态再写库 —— 界面立刻响应，不等落盘。
   *
   * @param next 要切换到的模式
   */
  setMode: (next: ThemeMode) => void;
}

const ThemePreferenceContext = createContext<ThemePreferenceValue | null>(null);

/**
 * 取主题偏好与切换函数。
 *
 * @returns 当前模式与切换函数
 * @throws 在 `<ThemePreferenceProvider>` 之外调用时抛错 —— 那是编码错误，
 *         不是运行时故障，宁可当场炸掉（与 `useDatabase` 同一套约定）
 */
export function useThemePreference(): ThemePreferenceValue {
  const value = useContext(ThemePreferenceContext);
  if (!value) throw new Error('主题偏好尚未就绪');
  return value;
}

/**
 * 把 `ThemeMode`（三态，含 `'system'`）翻译成 `ThemeOverride`（两态 + null）。
 *
 * 实现在 `themeMode.ts` 里 —— 纯逻辑放 `.tsx` 会被 jest 跳过（本项目没配 JSX
 * 预设），等于测不到。这里原样再导出，方便同模块的使用方少 import 一个路径。
 */
export { toThemeOverride };

/**
 * 读用户偏好 → 注入 Context → 提供切换能力。
 *
 * **必须放在 `<DatabaseProvider>` 之内**：它要读库。放在 `app/_layout.tsx`
 * 里数据库 Provider 的内层。
 *
 * @param props.children 应用子树
 * @returns 偏好就绪前是一个加载指示器，就绪后是带 Context 的子树
 */
export function ThemePreferenceProvider({ children }: { children: ReactNode }) {
  const exec = useDatabase();

  // 初值 'system'：读库之前先按跟随系统渲染。这里刻意**不**用「加载中」挡着 ——
  // 主题这种全局状态多一层闪烁比早几十毫秒渲染更难受。真正挡住子树的只有
  // 下面那个 `loaded` 标记，见它的注释
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [loaded, setLoaded] = useState(false);

  // 挂载时读一次。库里没存过（或存的是非法值）时 `getThemeMode` 会给出 'system'，
  // 所以这里不需要额外兜底
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await getThemeMode(exec);
      if (!cancelled) {
        setModeState(stored);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [exec]);

  /**
   * 切换主题。
   *
   * **先改内存再写库**，而且写库失败不阻塞界面：用户在设置页点一下，
   * 看到的必须是立刻变色。写库失败最多是「重启后回到旧偏好」，
   * 比点了没反应好得多 —— 后者会让用户以为这个按钮坏了。
   *
   * @param next 要切换到的模式
   */
  const setMode = useCallback(
    (next: ThemeMode) => {
      setModeState(next);
      void (async () => {
        try {
          await setThemeMode(exec, next);
        } catch {
          // 写库失败不回滚界面：本次会话内偏好仍然生效
        }
      })();
    },
    [exec],
  );

  // 偏好读出来之前不放行子树。
  //
  // **这一道是必要的，不是保守。** 主题决定整棵树的配色，如果先按 'system'
  // 渲染一帧、读到偏好后再整屏换成另一个颜色，用户每次冷启动都会看到一次闪烁。
  // 读一个键只有一次 SQL，代价可以忽略
  if (!loaded) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ThemePreferenceContext.Provider value={{ mode, setMode }}>
      <ThemeOverrideContext.Provider value={toThemeOverride(mode)}>
        {children}
      </ThemeOverrideContext.Provider>
    </ThemePreferenceContext.Provider>
  );
}
