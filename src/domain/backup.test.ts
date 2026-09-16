import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  buildBackup,
  validateBackup,
} from './backup';
import type { BackupData, BackupFile, BackupValidation } from './backup';
import type { Exercise, SessionExercise, SetEntry, WorkoutSession } from './types';

/**
 * 固定时间戳。绝不用 Date.now() —— 依赖「两次调用落在同一毫秒」的断言会随机变红。
 */
const EXPORTED_AT = 1_789_560_000_000;

function makeExercise(overrides: Partial<Exercise> = {}): Exercise {
  return {
    id: 'ex1',
    name: '卧推',
    muscleGroup: '胸',
    equipment: '杠铃',
    isCustom: false,
    isArchived: false,
    createdAt: EXPORTED_AT - 2 * 86_400_000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<WorkoutSession> = {}): WorkoutSession {
  return {
    id: 'sess1',
    name: '推日',
    startedAt: EXPORTED_AT - 3_600_000,
    finishedAt: EXPORTED_AT - 1_800_000,
    note: null,
    ...overrides,
  };
}

function makeSessionExercise(
  overrides: Partial<SessionExercise> = {},
): SessionExercise {
  return {
    id: 'se1',
    sessionId: 'sess1',
    exerciseId: 'ex1',
    position: 0,
    note: null,
    ...overrides,
  };
}

function makeSet(overrides: Partial<SetEntry> = {}): SetEntry {
  return {
    id: 'set1',
    sessionExerciseId: 'se1',
    position: 0,
    weight: 60,
    reps: 8,
    isCompleted: true,
    restSeconds: 120,
    restStartedAt: null,
    completedAt: EXPORTED_AT - 3_000_000,
    ...overrides,
  };
}

function validData(): BackupData {
  return {
    exercises: [makeExercise()],
    sessions: [makeSession()],
    sessionExercises: [makeSessionExercise()],
    sets: [makeSet()],
  };
}

function validFile(): BackupFile {
  return buildBackup(validData(), 1, EXPORTED_AT);
}

/**
 * 造一份「除了指定改动之外都合法」的原始输入，用来喂给 validateBackup。
 * overrides 覆盖顶层字段；dataPatch 覆盖 data 里的字段。
 */
function rawFile(
  overrides: Record<string, unknown> = {},
  dataPatch: Record<string, unknown> = {},
): unknown {
  const file = validFile() as unknown as Record<string, unknown>;
  const data = file.data as Record<string, unknown>;
  return { ...file, data: { ...data, ...dataPatch }, ...overrides };
}

function reasonOf(result: BackupValidation): string {
  if (result.ok) {
    throw new Error('期望校验失败，但它通过了');
  }
  return result.reason;
}

function backupOf(result: BackupValidation): BackupFile {
  if (!result.ok) {
    throw new Error(`期望校验通过，实际失败：${result.reason}`);
  }
  return result.backup;
}

describe('buildBackup', () => {
  it('写死 format 与 version，schemaVersion / exportedAt 原样带上', () => {
    const backup = buildBackup(validData(), 7, EXPORTED_AT);
    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.schemaVersion).toBe(7);
    expect(backup.exportedAt).toBe(EXPORTED_AT);
  });

  it('四个数组的内容原样带过去', () => {
    const data = validData();
    const backup = buildBackup(data, 1, EXPORTED_AT);
    expect(backup.data.exercises).toEqual(data.exercises);
    expect(backup.data.sessions).toEqual(data.sessions);
    expect(backup.data.sessionExercises).toEqual(data.sessionExercises);
    expect(backup.data.sets).toEqual(data.sets);
  });

  it('构造出来的文件一定通过校验（构造与校验不漂移）', () => {
    expect(validateBackup(buildBackup(validData(), 1, EXPORTED_AT)).ok).toBe(true);
  });
});

describe('validateBackup：顶层形状', () => {
  it('不是对象的输入一律拒绝，并且不抛异常', () => {
    const garbage: unknown[] = [null, undefined, 42, 'gym-tracker-backup', [], true];
    for (const input of garbage) {
      let result: BackupValidation | undefined;
      expect(() => {
        result = validateBackup(input);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      expect(reasonOf(result as BackupValidation).length).toBeGreaterThan(0);
    }
  });

  it('缺少 data 时拒绝', () => {
    const result = validateBackup(rawFile({ data: undefined }));
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('data');
  });

  it('data 是数组时拒绝', () => {
    const result = validateBackup(rawFile({ data: [] }));
    expect(result.ok).toBe(false);
  });

  it('data 是 null 时拒绝', () => {
    const result = validateBackup(rawFile({ data: null }));
    expect(result.ok).toBe(false);
  });
});

describe('validateBackup：format（识别「用户选错文件」）', () => {
  it('别的 JSON（{"hello":1}）被拒绝，理由里点明 format', () => {
    const result = validateBackup({ hello: 1 });
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('format');
  });

  it('format 必须精确匹配，大小写不同也拒绝', () => {
    expect(validateBackup(rawFile({ format: 'Gym-Tracker-Backup' })).ok).toBe(false);
    expect(validateBackup(rawFile({ format: `${BACKUP_FORMAT} ` })).ok).toBe(false);
    expect(validateBackup(rawFile({ format: 'gym-tracker' })).ok).toBe(false);
  });

  it('format 缺失时拒绝', () => {
    const result = validateBackup(rawFile({ format: undefined }));
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain(BACKUP_FORMAT);
  });
});

describe('validateBackup：version', () => {
  it('版本比当前新时必须拒绝，理由说明文件来自更新版本、不得降级读取', () => {
    const result = validateBackup(rawFile({ version: BACKUP_VERSION + 1 }));
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toContain('更新版本');
    expect(reason).toContain(String(BACKUP_VERSION + 1));
  });

  it('version 不是正整数时拒绝（小数 / 0 / 负数 / 字符串）', () => {
    for (const version of [1.5, 0, -1, '1', null, undefined]) {
      expect(validateBackup(rawFile({ version })).ok).toBe(false);
    }
  });

  it('version 等于当前版本时通过', () => {
    expect(backupOf(validateBackup(rawFile({ version: BACKUP_VERSION }))).version).toBe(
      BACKUP_VERSION,
    );
  });
});

describe('validateBackup：data 里的四个数组', () => {
  it('四个数组缺任何一个都拒绝', () => {
    for (const key of ['exercises', 'sessions', 'sessionExercises', 'sets']) {
      const result = validateBackup(rawFile({}, { [key]: undefined }));
      expect(result.ok).toBe(false);
      expect(reasonOf(result)).toContain(key);
    }
  });

  it('字段存在但不是数组时拒绝', () => {
    for (const key of ['exercises', 'sessions', 'sessionExercises', 'sets']) {
      expect(validateBackup(rawFile({}, { [key]: {} })).ok).toBe(false);
    }
  });

  it('合法的空备份（四个空数组）是合法的', () => {
    const backup = backupOf(
      validateBackup(
        rawFile({}, { exercises: [], sessions: [], sessionExercises: [], sets: [] }),
      ),
    );
    expect(backup.data.exercises).toEqual([]);
    expect(backup.data.sets).toEqual([]);
  });
});

describe('validateBackup：字段类型', () => {
  it('weight 是 NaN 时拒绝，理由指出是第几条的哪个字段', () => {
    const result = validateBackup(rawFile({}, { sets: [makeSet({ weight: Number.NaN })] }));
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toContain('sets');
    expect(reason).toContain('第 1 条');
    expect(reason).toContain('weight');
  });

  it('weight 是字符串 / Infinity 时拒绝', () => {
    expect(validateBackup(rawFile({}, { sets: [makeSet({ weight: '60' as unknown as number })] })).ok).toBe(false);
    expect(validateBackup(rawFile({}, { sets: [makeSet({ weight: Number.POSITIVE_INFINITY })] })).ok).toBe(false);
    expect(validateBackup(rawFile({}, { sets: [makeSet({ weight: Number.NEGATIVE_INFINITY })] })).ok).toBe(false);
  });

  it('reps 不是整数时拒绝', () => {
    const result = validateBackup(rawFile({}, { sets: [makeSet({ reps: 8.5 })] }));
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('reps');
  });

  it('isCompleted 不是布尔时拒绝', () => {
    const result = validateBackup(
      rawFile({}, { sets: [makeSet({ isCompleted: 1 as unknown as boolean })] }),
    );
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('isCompleted');
  });

  it('restSeconds 必须是 number | null，字符串拒绝、null 合法', () => {
    const bad = validateBackup(
      rawFile({}, { sets: [makeSet({ restSeconds: '120' as unknown as number })] }),
    );
    expect(bad.ok).toBe(false);
    expect(reasonOf(bad)).toContain('restSeconds');

    const nullable = validateBackup(rawFile({}, { sets: [makeSet({ restSeconds: null })] }));
    expect(nullable.ok).toBe(true);
  });

  it('restStartedAt 非 null 时必须是数字，null 合法', () => {
    const bad = validateBackup(
      rawFile({}, { sets: [makeSet({ restStartedAt: 'soon' as unknown as number })] }),
    );
    expect(bad.ok).toBe(false);
    expect(reasonOf(bad)).toContain('restStartedAt');

    expect(validateBackup(rawFile({}, { sets: [makeSet({ restStartedAt: null })] })).ok).toBe(true);
    expect(validateBackup(rawFile({}, { sets: [makeSet({ restStartedAt: EXPORTED_AT })] })).ok).toBe(true);
  });

  it('exercise 的布尔字段类型不对时拒绝', () => {
    const result = validateBackup(
      rawFile({}, { exercises: [makeExercise({ isCustom: 'false' as unknown as boolean })] }),
    );
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toContain('exercises');
    expect(reason).toContain('isCustom');
  });

  it('session 的时间戳是 NaN 时拒绝', () => {
    const result = validateBackup(
      rawFile({}, { sessions: [makeSession({ startedAt: Number.NaN })] }),
    );
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('startedAt');
  });

  it('sessionExercise 的 position 不是整数时拒绝', () => {
    const result = validateBackup(
      rawFile({}, { sessionExercises: [makeSessionExercise({ position: 0.5 })] }),
    );
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('position');
  });

  it('数组里混进 null / 字符串时拒绝', () => {
    expect(validateBackup(rawFile({}, { sets: [null] })).ok).toBe(false);
    expect(validateBackup(rawFile({}, { sessions: ['sess1'] })).ok).toBe(false);
  });

  it('理由指向真正坏掉的那一条（第二条坏掉时说第 2 条）', () => {
    const result = validateBackup(
      rawFile(
        {},
        {
          sets: [
            makeSet(),
            makeSet({ id: 'set2', position: 1, reps: 7.5 }),
          ],
        },
      ),
    );
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toContain('第 2 条');
    expect(reason).toContain('reps');
  });
});

describe('validateBackup：引用完整性', () => {
  it('sessionExercise.sessionId 在 sessions 里找不到时拒绝', () => {
    const result = validateBackup(
      rawFile({}, { sessionExercises: [makeSessionExercise({ sessionId: 'sess-ghost' })] }),
    );
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toContain('sessionExercises');
    expect(reason).toContain('sess-ghost');
  });

  it('sessionExercise.exerciseId 在 exercises 里找不到时拒绝', () => {
    const result = validateBackup(
      rawFile({}, { sessionExercises: [makeSessionExercise({ exerciseId: 'ex-ghost' })] }),
    );
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toContain('ex-ghost');
    expect(reason).toContain('exercises');
  });

  it('set.sessionExerciseId 在 sessionExercises 里找不到时拒绝', () => {
    const result = validateBackup(
      rawFile({}, { sets: [makeSet({ sessionExerciseId: 'se-ghost' })] }),
    );
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toContain('sets');
    expect(reason).toContain('se-ghost');
  });

  it('引用都指得通时通过（多对多的正常数据）', () => {
    const data = validData();
    data.sessionExercises = [
      makeSessionExercise(),
      makeSessionExercise({ id: 'se2', exerciseId: 'ex2', position: 1 }),
    ];
    data.exercises = [makeExercise(), makeExercise({ id: 'ex2', name: '深蹲', isCustom: true })];
    data.sets = [makeSet(), makeSet({ id: 'set2', sessionExerciseId: 'se2', position: 1 })];
    expect(validateBackup(buildBackup(data, 1, EXPORTED_AT)).ok).toBe(true);
  });
});

/**
 * 重复 id 的备份文件是「手工改坏」的典型产物：它每一处引用都指得通，
 * 所以引用完整性拦不住它，但导入时会撞主键 → 整个事务回滚。
 * 数据是安全的，用户看到的却是 SQL 层错误。这里的要求是给出人话。
 */
describe('validateBackup：重复 id', () => {
  it('exercises 里有重复 id 时拒绝，理由点名表和 id', () => {
    const result = validateBackup(
      rawFile({}, { exercises: [makeExercise(), makeExercise({ name: '深蹲' })] }),
    );
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toContain('data.exercises');
    expect(reason).toContain('ex1');
  });

  it('sessions 里有重复 id 时拒绝', () => {
    const result = validateBackup(
      rawFile({}, { sessions: [makeSession(), makeSession({ name: '腿日' })] }),
    );
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toContain('data.sessions');
    expect(reason).toContain('sess1');
  });

  it('sessionExercises 里有重复 id 时拒绝', () => {
    const result = validateBackup(
      rawFile(
        {},
        {
          sessionExercises: [
            makeSessionExercise(),
            makeSessionExercise({ position: 1 }),
          ],
        },
      ),
    );
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toContain('data.sessionExercises');
    expect(reason).toContain('se1');
  });

  it('sets 里有重复 id 时拒绝', () => {
    const result = validateBackup(
      rawFile({}, { sets: [makeSet(), makeSet({ position: 1 })] }),
    );
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toContain('data.sets');
    expect(reason).toContain('set1');
  });

  it('id 重复但内容不同的记录也算重复（按 id 判定，不按内容）', () => {
    const result = validateBackup(
      rawFile(
        {},
        {
          sets: [
            makeSet(),
            makeSet({ weight: 999, reps: 1, isCompleted: false }),
          ],
        },
      ),
    );
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('set1');
  });

  it('不同数组之间 id 同名不算重复（四张表的主键互不相干）', () => {
    const data = validData();
    data.exercises = [makeExercise({ id: 'same' })];
    data.sessions = [makeSession({ id: 'same' })];
    data.sessionExercises = [
      makeSessionExercise({ id: 'same', sessionId: 'same', exerciseId: 'same' }),
    ];
    data.sets = [makeSet({ id: 'same', sessionExerciseId: 'same' })];

    expect(validateBackup(buildBackup(data, 1, EXPORTED_AT)).ok).toBe(true);
  });
});

describe('validateBackup：返回规范化对象', () => {
  it('校验通过时剔除顶层多余字段，只保留格式定义的五个字段', () => {
    const result = validateBackup(
      rawFile({ evilTop: '不该透传', [BACKUP_FORMAT]: 'x' }),
    );
    const backup = backupOf(result) as unknown as Record<string, unknown>;
    expect(Object.keys(backup)).toEqual([
      'format',
      'version',
      'schemaVersion',
      'exportedAt',
      'data',
    ]);
    expect(backup.evilTop).toBeUndefined();
  });

  it('校验通过时剔除记录里多出来的字段，且字段顺序与 types.ts 一致', () => {
    const dirtySet = { ...makeSet(), evilSet: '不该透传' };
    const dirtyExercise = { ...makeExercise(), evilExercise: '不该透传' };
    const backup = backupOf(
      validateBackup(
        rawFile({}, { sets: [dirtySet], exercises: [dirtyExercise] }),
      ),
    );

    expect(Object.keys(backup.data)).toEqual([
      'exercises',
      'sessions',
      'sessionExercises',
      'sets',
    ]);
    expect(Object.keys(backup.data.sets[0])).toEqual([
      'id',
      'sessionExerciseId',
      'position',
      'weight',
      'reps',
      'isCompleted',
      'restSeconds',
      'restStartedAt',
      'completedAt',
    ]);
    expect(Object.keys(backup.data.exercises[0])).toEqual([
      'id',
      'name',
      'muscleGroup',
      'equipment',
      'isCustom',
      'isArchived',
      'createdAt',
    ]);
    const set = backup.data.sets[0] as unknown as Record<string, unknown>;
    const exercise = backup.data.exercises[0] as unknown as Record<string, unknown>;
    expect(set.evilSet).toBeUndefined();
    expect(exercise.evilExercise).toBeUndefined();
  });

  it('规范化后返回的是新对象，不是 input 本身', () => {
    const input = rawFile();
    const backup = backupOf(validateBackup(input));
    expect(backup).not.toBe(input);
    expect(backup.data).not.toBe((input as { data: unknown }).data);
  });
});

describe('validateBackup：永不抛异常', () => {
  it('各种畸形输入都只返回 { ok: false, reason }', () => {
    const weird: unknown[] = [
      { format: BACKUP_FORMAT, version: BACKUP_VERSION, data: 'nope' },
      { format: BACKUP_FORMAT, version: BACKUP_VERSION, data: { exercises: 'x' } },
      { format: BACKUP_FORMAT, version: BACKUP_VERSION, data: { exercises: [{}] } },
      { format: BACKUP_FORMAT, version: BACKUP_VERSION, data: { exercises: [], sets: [{ id: 1 }] } },
      { format: BACKUP_FORMAT, version: BACKUP_VERSION, data: { sets: [{ weight: {} }] } },
      Object.create(null) as unknown,
    ];
    for (const input of weird) {
      let result: BackupValidation | undefined;
      expect(() => {
        result = validateBackup(input);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      expect(reasonOf(result as BackupValidation).length).toBeGreaterThan(0);
    }
  });
});
