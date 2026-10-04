import { createMigratedExecutor, createNodeExecutor } from '../db/__tests__/nodeExecutor';
import { migrate } from '../db/migrations';
import { CREATE_META_SQL, CREATE_TABLES_SQL } from '../db/schema';
import {
  THEME_MODE_KEY,
  getSetting,
  getThemeMode,
  isThemeMode,
  setSetting,
  setThemeMode,
} from './settingsRepo';

describe('settingsRepo 通用键值读写', () => {
  it('没写过的键返回 null，而不是空串', async () => {
    const exec = await createMigratedExecutor();
    expect(await getSetting(exec, 'never_written')).toBeNull();
  });

  it('写入后能读回来', async () => {
    const exec = await createMigratedExecutor();
    await setSetting(exec, 'k', 'v');
    expect(await getSetting(exec, 'k')).toBe('v');
  });

  it('重复写同一个键是覆盖，不是插入第二行', async () => {
    const exec = await createMigratedExecutor();
    await setSetting(exec, 'k', 'first');
    await setSetting(exec, 'k', 'second');
    expect(await getSetting(exec, 'k')).toBe('second');

    const rows = await exec.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM app_setting WHERE key = ?',
      ['k'],
    );
    expect(rows[0].n).toBe(1);
  });

  it('空串是一个合法的、被显式写入过的值，必须能和「没写过」区分开', async () => {
    const exec = await createMigratedExecutor();
    await setSetting(exec, 'empty', '');
    expect(await getSetting(exec, 'empty')).toBe('');
    expect(await getSetting(exec, 'empty')).not.toBeNull();
  });
});

describe('isThemeMode', () => {
  it.each(['system', 'light', 'dark'])('接受合法值 %s', (value) => {
    expect(isThemeMode(value)).toBe(true);
  });

  it.each(['', 'System', 'LIGHT', 'auto', 'true', '1', '深色'])(
    '拒绝非法值 %s',
    (value) => {
      expect(isThemeMode(value)).toBe(false);
    },
  );
});

describe('主题模式', () => {
  it('从没设置过时返回 system（默认跟随系统）', async () => {
    const exec = await createMigratedExecutor();
    expect(await getThemeMode(exec)).toBe('system');
  });

  it.each(['light', 'dark', 'system'] as const)(
    '存取往返保持 %s',
    async (mode) => {
      const exec = await createMigratedExecutor();
      await setThemeMode(exec, mode);
      expect(await getThemeMode(exec)).toBe(mode);
    },
  );

  it('库里是非法值时退回 system，而不是抛错', async () => {
    // 这个值的来源不可控：可能是旧版本写的、手改库改的、或将来改过语义的。
    // 主题读不出来不该让整个 App 起不来
    const exec = await createMigratedExecutor();
    await setSetting(exec, THEME_MODE_KEY, 'chartreuse');
    expect(await getThemeMode(exec)).toBe('system');
  });

  it('用的是约定的那个键名', async () => {
    const exec = await createMigratedExecutor();
    await setThemeMode(exec, 'dark');
    expect(await getSetting(exec, THEME_MODE_KEY)).toBe('dark');
  });
});

describe('v1 -> v2 迁移', () => {
  it('已经跑过 v1 的旧库能升到 v2 并建出 app_setting 表', async () => {
    // 关键回归：真机上装着的旧版本库已经是 v1，`schema_version` 也是 1。
    // 如果 v2 那一项被误并进 v1，这些库永远不会再跑 v1，表就永远建不出来。
    const { exec } = createNodeExecutor();

    // 手工造一个「只跑到 v1」的库，不能直接调 migrate（那会一路跑到最新）
    await exec.run(CREATE_META_SQL);
    await exec.run(CREATE_TABLES_SQL);
    await exec.run(
      "INSERT INTO app_meta (key, value) VALUES ('schema_version', '1')",
    );

    const tablesBefore = await exec.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_setting'",
    );
    expect(tablesBefore).toHaveLength(0);

    await migrate(exec);

    const tablesAfter = await exec.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_setting'",
    );
    expect(tablesAfter).toHaveLength(1);

    // 迁移完能正常读写设置
    await setThemeMode(exec, 'light');
    expect(await getThemeMode(exec)).toBe('light');
  });

  it('全新库从 0 一路跑到最新，同样得到 app_setting', async () => {
    const exec = await createMigratedExecutor();
    await setThemeMode(exec, 'dark');
    expect(await getThemeMode(exec)).toBe('dark');
  });
});
