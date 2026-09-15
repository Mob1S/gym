import { createNodeExecutor } from './__tests__/nodeExecutor';
import { migrate, getSchemaVersion, MIGRATIONS } from './migrations';

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
