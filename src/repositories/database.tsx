import * as SQLite from 'expo-sqlite';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { createExpoExecutor } from '../db/expoSqlite';
import { migrate } from '../db/migrations';
import type { SqlExecutor } from '../db/types';
import { seedExercisesIfEmpty } from './exerciseRepo';

/**
 * 应用级数据库上下文。
 *
 * **为什么放在 `src/repositories/` 而不是 `app/_layout.tsx`：**
 * 一是全局约束规定界面层永远不直接 import `src/db/`，Provider 必须建库、
 * 跑迁移、播种，这些都属于数据层；二是从路由文件里 export 组件再给别的路由
 * import，会和 expo-router 的布局树形成循环依赖。`app/_layout.tsx` 只是薄薄一层，
 * 包 `<DatabaseProvider>` 和 `<Stack>`。
 *
 * 数据库就绪之前不放行 children，因此界面层拿到的 `useDatabase()` 永远非空，
 * 不需要到处判空。
 */
/**
 * 数据库上下文的载体。
 *
 * 初值是 `null`，但 Provider **在数据库就绪之前不放行 children**，所以凡是能
 * 渲染出来的组件，`useContext` 拿到的必然非空。`null` 只表示「还没就绪」，
 * 不是一种运行时状态。
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
 * 建库 → 开外键 → 跑迁移 → 播种，四步全部成功后才渲染 children。
 *
 * 四步的顺序有依赖：迁移依赖外键开关（级联删除）之外的 schema，播种依赖表已存在。
 * 任一步失败都不放行，而是渲染一段错误文案 —— 比让界面在半个库上乱跑强。
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
        const db = await SQLite.openDatabaseAsync('gym.db');
        // 外键约束按连接生效，必须在每次打开后单独开启。
        // node:sqlite 的测试适配器同样开了它，两边行为保持一致。
        await db.execAsync('PRAGMA foreign_keys = ON');
        const executor = createExpoExecutor(db);
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
        }}
      >
        <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 8 }}>
          数据库初始化失败
        </Text>
        <Text style={{ textAlign: 'center', color: '#666' }}>{error}</Text>
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
    <DatabaseContext.Provider value={exec}>{children}</DatabaseContext.Provider>
  );
}
