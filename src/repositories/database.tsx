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
const DatabaseContext = createContext<SqlExecutor | null>(null);

export function useDatabase(): SqlExecutor {
  const exec = useContext(DatabaseContext);
  if (!exec) throw new Error('数据库尚未就绪');
  return exec;
}

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
