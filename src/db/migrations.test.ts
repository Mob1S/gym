import { createNodeExecutor } from './__tests__/nodeExecutor';
import { migrate, getSchemaVersion, MIGRATIONS } from './migrations';
import { CREATE_META_SQL, CREATE_SETTINGS_SQL, CREATE_TABLES_SQL } from './schema';

async function tableNames(exec: ReturnType<typeof createNodeExecutor>['exec']) {
  const rows = await exec.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return rows.map((r) => r.name);
}

describe('migrate', () => {
  it('建出全部业务表', async () => {
    const { exec } = createNodeExecutor();
    await migrate(exec);
    const names = await tableNames(exec);
    expect(names).toEqual(
      expect.arrayContaining([
        'app_meta',
        'exercise',
        'session',
        'session_exercise',
        'set_entry',
      ]),
    );
  });

  it('迁移后版本号等于最大迁移版本', async () => {
    const { exec } = createNodeExecutor();
    await migrate(exec);
    const maxVersion = Math.max(...MIGRATIONS.map((m) => m.version));
    expect(await getSchemaVersion(exec)).toBe(maxVersion);
  });

  it('重复调用是幂等的，不报错', async () => {
    const { exec } = createNodeExecutor();
    await migrate(exec);
    await migrate(exec);
    await migrate(exec);
    expect(await getSchemaVersion(exec)).toBe(
      Math.max(...MIGRATIONS.map((m) => m.version)),
    );
  });

  it('未迁移时版本号为 0', async () => {
    const { exec } = createNodeExecutor();
    expect(await getSchemaVersion(exec)).toBe(0);
  });

  it('外键约束已开启：插入不存在的 session 会被拒绝', async () => {
    const { exec } = createNodeExecutor();
    await migrate(exec);
    await expect(
      exec.run(
        `INSERT INTO session_exercise (id, session_id, exercise_id, position)
         VALUES ('se1', 'nope', 'nope2', 0)`,
      ),
    ).rejects.toThrow();
  });
});

/** 手工造一个 v2 的库：只建 v1/v2 会建的东西，版本号停在 2 */
async function createV2Database(): Promise<ReturnType<typeof createNodeExecutor>['exec']> {
  const { exec } = createNodeExecutor();
  await exec.run(CREATE_META_SQL);
  await exec.run(CREATE_TABLES_SQL);
  await exec.run(CREATE_SETTINGS_SQL);
  await exec.run(
    "INSERT INTO app_meta (key, value) VALUES ('schema_version', '2')",
  );
  return exec;
}

describe('v3 迁移：分化计划', () => {
  it('建出两张新表，并给 session 加上 template_id 列', async () => {
    const { exec } = createNodeExecutor();
    await migrate(exec);

    const names = await tableNames(exec);
    expect(names).toEqual(
      expect.arrayContaining(['split_template', 'template_exercise']),
    );

    const columns = await exec.all<{ name: string }>(
      'PRAGMA table_info(session)',
    );
    expect(columns.map((c) => c.name)).toContain('template_id');
  });

  it('从 v2 老库升级：新列加得上，老数据一行不丢', async () => {
    const exec = await createV2Database();
    await exec.run(
      `INSERT INTO session (id, name, started_at, finished_at, note)
       VALUES ('old-1', '老训练', 1000, 2000, NULL)`,
    );

    await migrate(exec);

    const row = await exec.first<{ name: string; template_id: string | null }>(
      'SELECT name, template_id FROM session WHERE id = ?',
      ['old-1'],
    );
    // 老记录必须还在，且新列是 NULL —— 不能因为加列把数据冲掉
    expect(row?.name).toBe('老训练');
    expect(row?.template_id).toBeNull();
    expect(await getSchemaVersion(exec)).toBe(3);
  });
});
