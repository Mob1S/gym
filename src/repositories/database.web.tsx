import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Text as ThemedText } from '../ui/Text';
import { createDemoExecutor } from '../db/demoExecutor';
import { migrate } from '../db/migrations';
import type { SqlExecutor } from '../db/types';
import { ThemePreferenceProvider } from '../store/themePreference';
import { seedExercisesIfEmpty } from './exerciseRepo';

/**
 * **网页预览版**的数据库 Provider。
 *
 * 平台解析规则让这个文件在 web 上顶替 `database.tsx`（Metro 优先取 `.web.tsx`），
 * 所以 `expo-sqlite` 在 web 包里根本不会被 import —— 这正是目的：
 * 它的 web 实现依赖 Web Worker，而 Metro 的静态 web 打包器不支持 worker 分块
 * （详见 `src/db/demoExecutor.ts` 的说明）。
 *
 * 真机（Android / iOS）走的仍然是 `database.tsx` + `expo-sqlite`。
 * 本文件与 `demoExecutor.ts` 都不参与原生构建。
 *
 * 数据是内置的演示数据（`demoExecutor.ts` 里造好），**与手机上的真实记录完全隔离** ——
 * web 端没有持久化，刷新页面即恢复初始的演示数据。
 */

/**
 * 数据库上下文的载体。与 `database.tsx` 里的同名对象是两份独立实现，
 * 但对外契约完全一致：Provider 就绪之前不放行 children，所以 `useDatabase()`
 * 永远拿到非空值。
 */
const DatabaseContext = createContext<SqlExecutor | null>(null);

/**
 * 取数据库执行器。界面层访问数据的唯一入口。
 *
 * @returns 已就绪的 `SqlExecutor`（永不返回 null，调用方不必判空）
 * @throws 在 `<DatabaseProvider>` 之外调用时抛错 —— 那是编码错误，
 *         不是运行时故障，宁可当场炸掉
 */
export function useDatabase(): SqlExecutor {
  const exec = useContext(DatabaseContext);
  if (!exec) throw new Error('数据库尚未就绪');
  return exec;
}

/**
 * 建库 → 开外键 → 跑迁移 → 播种。四步的顺序与 `database.tsx` 保持一致。
 *
 * 这里跑 `migrate` 与 `seedExercisesIfEmpty` **不是为了建表**（内存版不建表），
 * 而是为了走一遍和真机相同的启动路径 —— 那两句会把 `PRAGMA` / `CREATE` /
 * 播种用的 `INSERT` 发过来，`createDemoExecutor` 会安静地接住。
 * 这样两边「启动时发生了什么」不会悄悄分叉。
 *
 * @param props.children 数据库就绪后才渲染的子树（正常情况下是整个 App）
 * @returns 就绪前是加载指示器，失败时是错误页，成功时是带 Context 的子树
 */
export function DatabaseProvider({ children }: { children: ReactNode }) {
  const [exec, setExec] = useState<SqlExecutor | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const executor = createDemoExecutor();
        await migrate(executor);
        await seedExercisesIfEmpty(executor);
        if (!cancelled) setExec(executor);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          gap: 8,
        }}
      >
        <ThemedText variant="title">数据库初始化失败</ThemedText>
        <ThemedText
          variant="caption"
          color="danger"
          style={{ textAlign: 'center' }}
        >
          {error}
        </ThemedText>
      </View>
    );
  }

  if (!exec) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <DatabaseContext.Provider value={exec}>
      {/* 与真机版 database.tsx 保持同一种嵌套：主题偏好要读库，
          所以必须包在数据库 Provider 之内 */}
      <ThemePreferenceProvider>{children}</ThemePreferenceProvider>
    </DatabaseContext.Provider>
  );
}
