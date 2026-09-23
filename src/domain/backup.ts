import type {
  Exercise,
  SessionExercise,
  SetEntry,
  WorkoutSession,
} from './types';

/**
 * 备份文件的构造与校验。
 *
 * 这是纯逻辑：不碰数据库、不碰文件系统、不读时钟。导入的语义是**整库替换**，
 * 所以校验不过就必须一个字节都不写 —— 本模块的所有失败都表现为
 * `{ ok: false, reason }`，**绝不抛异常**（`JSON.parse` 那一步在调用方）。
 *
 * `reason` 必须让人能自救：说清是哪个数组、第几条、哪个字段、收到了什么。
 */

/** 固定字符串，用来识别「这是不是本 App 导出的文件」 */
export const BACKUP_FORMAT = 'gym-tracker-backup';

/** 备份格式版本。读到比它大的版本必须拒绝，不能静默降级读取 */
export const BACKUP_VERSION = 1;

export interface BackupData {
  exercises: Exercise[];
  sessions: WorkoutSession[];
  sessionExercises: SessionExercise[];
  sets: SetEntry[];
}

export interface BackupFile {
  format: string;
  version: number;
  schemaVersion: number;
  exportedAt: number;
  data: BackupData;
}

export type BackupValidation =
  | { ok: true; backup: BackupFile }
  | { ok: false; reason: string };

/**
 * 组装一份备份文件。只做组装，不做校验 —— 数据来自本机仓储，是可信来源；
 * 校验的门在 `validateBackup`（读别人的文件时才需要）。
 */
/**
 * @param data 四张表的全部实体，直接来自 `backupRepo.exportAll`
 * @param schemaVersion 导出时库的结构版本（各仓储之上的 `SCHEMA_VERSION`）
 * @param exportedAt 导出时刻的时间戳；**同时决定备份文件名**，所以由调用方
 *                   传入同一个值，别让文件内容和文件名各读一次时钟
 * @returns 可直接 `JSON.stringify` 落盘的备份对象
 */
export function buildBackup(
  data: BackupData,
  schemaVersion: number,
  exportedAt: number,
): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion,
    exportedAt,
    data,
  };
}

/**
 * 「取一个字段」的结果。**不用异常表达失败** —— 校验要检查几十个字段，
 * 每个都 try/catch 会让主流程读不出「检查了哪些字段」这个顺序。
 */
type FieldResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * @param reason 已经是给用户看的中文理由
 * @returns 失败结果，直接往上层抛
 */
function fail(reason: string): BackupValidation {
  return { ok: false, reason };
}

/**
 * 判断是不是「普通对象」。
 *
 * **必须排除数组和 null**：`typeof null === 'object'`、`typeof [] === 'object'`，
 * 少了这两个排除，一个数组会被当成合法的 `data` 放进去，然后在取字段时才炸。
 *
 * @param value 任意值
 * @returns true 表示可以按下标取字段
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把收到的值描述成一小段人能看懂的文字，放进 reason 里。
 *
 * @param value 用户文件里那个不合法的值
 * @returns 如 `null` / `数组(3 项)` / `字符串 "abc"` / `对象`；
 *          **字符串会带引号**，因为用户最常遇到的错误就是「字段类型对但值是错的」
 */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `数组(${value.length} 项)`;
  if (typeof value === 'string') return `字符串 ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `数字 ${String(value)}`;
  if (typeof value === 'object') return '对象';
  return `${typeof value} ${String(value)}`;
}

/**
 * @param source 待检查的记录
 * @param key 字段名
 * @param label 拼进 reason 里的中文位置说明，如 `data.exercises 第 3 条的 id`
 * @returns 该字段的值；**空字符串也算不合法**（id 为空就没法引用）
 */
function takeString(
  source: Record<string, unknown>,
  key: string,
  label: string,
): FieldResult<string> {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: `${label} 必须是非空字符串（收到 ${describe(value)}）` };
  }
  return { ok: true, value };
}

/**
 * @param source 待检查的记录
 * @param key 字段名
 * @param label 拼进 reason 里的中文位置说明
 * @returns 字符串或 null；**缺字段（undefined）会被拒绝**，必须显式写 null
 */
function takeNullableString(
  source: Record<string, unknown>,
  key: string,
  label: string,
): FieldResult<string | null> {
  const value = source[key];
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') {
    return { ok: false, reason: `${label} 必须是字符串或 null（收到 ${describe(value)}）` };
  }
  return { ok: true, value };
}

/**
 * @param source 待检查的记录
 * @param key 字段名
 * @param label 拼进 reason 里的中文位置说明
 * @returns 布尔值；**0/1 会被拒绝**（JSON 里就该是 true/false，宽容处理会让
 *          格式定义失去意义）
 */
function takeBoolean(
  source: Record<string, unknown>,
  key: string,
  label: string,
): FieldResult<boolean> {
  const value = source[key];
  if (typeof value !== 'boolean') {
    return { ok: false, reason: `${label} 必须是布尔值（收到 ${describe(value)}）` };
  }
  return { ok: true, value };
}

/**
 * 有限数字：NaN / Infinity / 字符串统统不接受。
 *
 * @param source 待检查的记录
 * @param key 字段名
 * @param label 拼进 reason 里的中文位置说明
 * @returns 有限数；`NaN` 会被拦下，因为它写进库之后会让所有比较都变成 false
 */
function takeFiniteNumber(
  source: Record<string, unknown>,
  key: string,
  label: string,
): FieldResult<number> {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: `${label} 必须是有限数字（收到 ${describe(value)}）` };
  }
  return { ok: true, value };
}

/**
 * @param source 待检查的记录
 * @param key 字段名
 * @param label 拼进 reason 里的中文位置说明
 * @returns 有限数或 null（用于 `finishedAt` / `restSeconds` 这类可空时间字段）
 */
function takeNullableFiniteNumber(
  source: Record<string, unknown>,
  key: string,
  label: string,
): FieldResult<number | null> {
  const value = source[key];
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      ok: false,
      reason: `${label} 必须是有限数字或 null（收到 ${describe(value)}）`,
    };
  }
  return { ok: true, value };
}

/**
 * @param source 待检查的记录
 * @param key 字段名
 * @param label 拼进 reason 里的中文位置说明
 * @returns 整数；`position` / `reps` 用它 —— 小数会让界面上的「第几组」错位
 */
function takeInteger(
  source: Record<string, unknown>,
  key: string,
  label: string,
): FieldResult<number> {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, reason: `${label} 必须是整数（收到 ${describe(value)}）` };
  }
  return { ok: true, value };
}

/**
 * 把一条原始记录规范化成具体实体：字段逐个对着 `domain/types.ts` 检查，
 * 只保留格式定义里的字段（多余的字段一律丢掉，不让脏数据透传到数据库）。
 * 字段顺序也与 `types.ts` 保持一致。
 */
/**
 * @param raw `data.exercises` 里的第 index 项，类型未知
 * @param index 从 0 开始的下标，**只用来拼「第 N 条」**（所以 reason 里写的是 `index + 1`）
 * @returns 规范化后的 `Exercise`，只含格式定义里的字段
 */
function normalizeExercise(raw: unknown, index: number): FieldResult<Exercise> {
  const label = `data.exercises 第 ${index + 1} 条`;
  if (!isPlainObject(raw)) {
    return { ok: false, reason: `${label} 必须是对象（收到 ${describe(raw)}）` };
  }

  const id = takeString(raw, 'id', `${label} 的 id`);
  if (!id.ok) return id;
  const name = takeString(raw, 'name', `${label} 的 name`);
  if (!name.ok) return name;
  const muscleGroup = takeNullableString(raw, 'muscleGroup', `${label} 的 muscleGroup`);
  if (!muscleGroup.ok) return muscleGroup;
  const equipment = takeNullableString(raw, 'equipment', `${label} 的 equipment`);
  if (!equipment.ok) return equipment;
  const isCustom = takeBoolean(raw, 'isCustom', `${label} 的 isCustom`);
  if (!isCustom.ok) return isCustom;
  const isArchived = takeBoolean(raw, 'isArchived', `${label} 的 isArchived`);
  if (!isArchived.ok) return isArchived;
  const createdAt = takeFiniteNumber(raw, 'createdAt', `${label} 的 createdAt`);
  if (!createdAt.ok) return createdAt;

  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      muscleGroup: muscleGroup.value,
      equipment: equipment.value,
      isCustom: isCustom.value,
      isArchived: isArchived.value,
      createdAt: createdAt.value,
    },
  };
}

/**
 * @param raw `data.sessions` 里的第 index 项
 * @param index 从 0 开始的下标，用来拼「第 N 条」
 * @returns 规范化后的 `WorkoutSession`；`finishedAt` 为 null 表示这是一场
 *          进行中的训练 —— **合法，不拒绝**
 */
function normalizeSession(raw: unknown, index: number): FieldResult<WorkoutSession> {
  const label = `data.sessions 第 ${index + 1} 条`;
  if (!isPlainObject(raw)) {
    return { ok: false, reason: `${label} 必须是对象（收到 ${describe(raw)}）` };
  }

  const id = takeString(raw, 'id', `${label} 的 id`);
  if (!id.ok) return id;
  const name = takeNullableString(raw, 'name', `${label} 的 name`);
  if (!name.ok) return name;
  const startedAt = takeFiniteNumber(raw, 'startedAt', `${label} 的 startedAt`);
  if (!startedAt.ok) return startedAt;
  const finishedAt = takeNullableFiniteNumber(raw, 'finishedAt', `${label} 的 finishedAt`);
  if (!finishedAt.ok) return finishedAt;
  const note = takeNullableString(raw, 'note', `${label} 的 note`);
  if (!note.ok) return note;

  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      startedAt: startedAt.value,
      finishedAt: finishedAt.value,
      note: note.value,
    },
  };
}

/**
 * @param raw `data.sessionExercises` 里的第 index 项
 * @param index 从 0 开始的下标，用来拼「第 N 条」
 * @returns 规范化后的 `SessionExercise`；它引用的 sessionId/exerciseId
 *          是否存在由 `validateBackup` 的引用完整性检查负责，这里只看类型
 */
function normalizeSessionExercise(
  raw: unknown,
  index: number,
): FieldResult<SessionExercise> {
  const label = `data.sessionExercises 第 ${index + 1} 条`;
  if (!isPlainObject(raw)) {
    return { ok: false, reason: `${label} 必须是对象（收到 ${describe(raw)}）` };
  }

  const id = takeString(raw, 'id', `${label} 的 id`);
  if (!id.ok) return id;
  const sessionId = takeString(raw, 'sessionId', `${label} 的 sessionId`);
  if (!sessionId.ok) return sessionId;
  const exerciseId = takeString(raw, 'exerciseId', `${label} 的 exerciseId`);
  if (!exerciseId.ok) return exerciseId;
  const position = takeInteger(raw, 'position', `${label} 的 position`);
  if (!position.ok) return position;
  const note = takeNullableString(raw, 'note', `${label} 的 note`);
  if (!note.ok) return note;

  return {
    ok: true,
    value: {
      id: id.value,
      sessionId: sessionId.value,
      exerciseId: exerciseId.value,
      position: position.value,
      note: note.value,
    },
  };
}

/**
 * @param raw `data.sets` 里的第 index 项
 * @param index 从 0 开始的下标，用来拼「第 N 条」
 * @returns 规范化后的 `SetEntry`；三个可空时间字段（`restSeconds` /
 *          `restStartedAt` / `completedAt`）都允许 null
 */
function normalizeSet(raw: unknown, index: number): FieldResult<SetEntry> {
  const label = `data.sets 第 ${index + 1} 条`;
  if (!isPlainObject(raw)) {
    return { ok: false, reason: `${label} 必须是对象（收到 ${describe(raw)}）` };
  }

  const id = takeString(raw, 'id', `${label} 的 id`);
  if (!id.ok) return id;
  const sessionExerciseId = takeString(
    raw,
    'sessionExerciseId',
    `${label} 的 sessionExerciseId`,
  );
  if (!sessionExerciseId.ok) return sessionExerciseId;
  const position = takeInteger(raw, 'position', `${label} 的 position`);
  if (!position.ok) return position;
  const weight = takeFiniteNumber(raw, 'weight', `${label} 的 weight`);
  if (!weight.ok) return weight;
  const reps = takeInteger(raw, 'reps', `${label} 的 reps`);
  if (!reps.ok) return reps;
  const isCompleted = takeBoolean(raw, 'isCompleted', `${label} 的 isCompleted`);
  if (!isCompleted.ok) return isCompleted;
  const restSeconds = takeNullableFiniteNumber(
    raw,
    'restSeconds',
    `${label} 的 restSeconds`,
  );
  if (!restSeconds.ok) return restSeconds;
  const restStartedAt = takeNullableFiniteNumber(
    raw,
    'restStartedAt',
    `${label} 的 restStartedAt`,
  );
  if (!restStartedAt.ok) return restStartedAt;
  const completedAt = takeNullableFiniteNumber(
    raw,
    'completedAt',
    `${label} 的 completedAt`,
  );
  if (!completedAt.ok) return completedAt;

  return {
    ok: true,
    value: {
      id: id.value,
      sessionExerciseId: sessionExerciseId.value,
      position: position.value,
      weight: weight.value,
      reps: reps.value,
      isCompleted: isCompleted.value,
      restSeconds: restSeconds.value,
      restStartedAt: restStartedAt.value,
      completedAt: completedAt.value,
    },
  };
}

/**
 * 在同一个数组里找重复的 id，找到就给出理由（带表名、id、第几条）。
 *
 * 为什么必须单独查一遍：重复 id 的记录**引用完整性是过得去的**（引用集合用
 * Set 去重，反而把重复吞掉了），但导入时会撞主键 → 整个事务回滚。数据是安全的，
 * 用户看到的却是 SQL 层错误。按「校验失败必须给出能直接弹给用户的中文理由」，
 * 得在这里拦下来。
 *
 * 只查数组内部：四张表的主键互不相干，不同数组之间 id 同名是合法的。
 */
/**
 * @param items 同一个数组里的全部记录
 * @param tableLabel 数组名，如 `data.exercises`，拼进 reason
 * @returns 重复时返回中文理由（含 id 与两条的位置）；**没有重复时返回 null**
 */
function findDuplicateId(items: { id: string }[], tableLabel: string): string | null {
  const firstIndexById = new Map<string, number>();
  for (let i = 0; i < items.length; i += 1) {
    const id = items[i].id;
    const firstIndex = firstIndexById.get(id);
    if (firstIndex !== undefined) {
      return `${tableLabel} 里有重复的 id ${JSON.stringify(id)}（第 ${firstIndex + 1} 条和第 ${i + 1} 条）—— 导入时会撞主键、整份备份都写不进去。请修好这个 id 重复后重试`;
    }
    firstIndexById.set(id, i);
  }
  return null;
}

/**
 * 取出一个数组字段并逐条规范化，**第一条出错就整体失败**（不做「跳过坏数据」）。
 *
 * @param data 备份的 `data` 对象
 * @param key 数组的字段名
 * @param normalize 单条记录的规范化函数（`normalizeExercise` 等）
 * @returns 规范化后的数组；字段缺失或不是数组时失败
 */
function normalizeList<T>(
  data: Record<string, unknown>,
  key: string,
  normalize: (raw: unknown, index: number) => FieldResult<T>,
): FieldResult<T[]> {
  const raw = data[key];
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `data.${key} 必须是数组（收到 ${describe(raw)}）` };
  }
  const list: T[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = normalize(raw[i], i);
    if (!item.ok) return item;
    list.push(item.value);
  }
  return { ok: true, value: list };
}

/**
 * 校验一份「从文件里读出来的」东西。只读不写：不碰数据库，也不改 input。
 *
 * 覆盖的失败：
 *   1. 顶层不是对象（含 null / 数组）
 *   2. format 不精确匹配（用户选错了文件）
 *   3. version 不是正整数
 *   4. version 比当前新 —— 拒绝，不能按旧格式降级读取
 *   5. data 不是对象
 *   6. 四个数组缺任何一个 / 不是数组
 *   7. 每条记录的字段类型不对（理由带上第几条的哪个字段）
 *   8. 同一个数组里 id 重复（引用完整性拦不住它，但导入时会撞主键）
 *   9. 引用完整性：孤儿 sessionExercise / 孤儿 set
 *  10. 通过时返回规范化对象，多余的字段不透传
 */
/**
 * @param input `JSON.parse` 之后的任意值 —— 可能是图片、PDF、别的 App 的导出，
 *              所以这里对**每一个字段**都不信任
 * @returns 通过时给出**规范化后的**备份对象（多余字段已丢弃）：
 *          `{ ok: true, backup }`；失败时给出可直接弹给用户的中文
 *          `{ ok: false, reason }`。**永不抛异常**
 */
export function validateBackup(input: unknown): BackupValidation {
  // 1. 顶层形状
  if (!isPlainObject(input)) {
    return fail(`备份文件的顶层必须是一个对象（收到 ${describe(input)}）`);
  }

  // 2. format 必须精确匹配 —— 这是识别「用户选错文件」的关键
  if (input.format !== BACKUP_FORMAT) {
    return fail(
      `format 必须是 "${BACKUP_FORMAT}"，实际收到 ${describe(input.format)} —— 这多半不是本 App 导出的备份文件`,
    );
  }

  // 3. version 必须是正整数
  const version = input.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return fail(`version 必须是正整数（收到 ${describe(version)}）`);
  }

  // 4. 比当前新的版本必须拒绝，绝不能猜着读
  if (version > BACKUP_VERSION) {
    return fail(
      `备份文件来自更新版本的 App（文件 version 为 ${version}，当前只支持到 ${BACKUP_VERSION}）—— 请先升级 App 再导入，不能按旧格式读取`,
    );
  }

  const schemaVersion = takeFiniteNumber(input, 'schemaVersion', 'schemaVersion');
  if (!schemaVersion.ok) return fail(schemaVersion.reason);

  const exportedAt = takeFiniteNumber(input, 'exportedAt', 'exportedAt');
  if (!exportedAt.ok) return fail(exportedAt.reason);

  // 5. data 必须是对象
  const data = input.data;
  if (!isPlainObject(data)) {
    return fail(`data 必须是对象（收到 ${describe(data)}）`);
  }

  // 6 + 7. 四个数组齐不齐，以及每条记录的字段类型
  const exercises = normalizeList(data, 'exercises', normalizeExercise);
  if (!exercises.ok) return fail(exercises.reason);

  const sessions = normalizeList(data, 'sessions', normalizeSession);
  if (!sessions.ok) return fail(sessions.reason);

  const sessionExercises = normalizeList(
    data,
    'sessionExercises',
    normalizeSessionExercise,
  );
  if (!sessionExercises.ok) return fail(sessionExercises.reason);

  const sets = normalizeList(data, 'sets', normalizeSet);
  if (!sets.ok) return fail(sets.reason);

  // 8. 每个数组内部的 id 不能重复（重复 id 会撞主键，理由要给成人话）
  const lists: { label: string; items: { id: string }[] }[] = [
    { label: 'data.exercises', items: exercises.value },
    { label: 'data.sessions', items: sessions.value },
    { label: 'data.sessionExercises', items: sessionExercises.value },
    { label: 'data.sets', items: sets.value },
  ];
  for (const list of lists) {
    const duplicate = findDuplicateId(list.items, list.label);
    if (duplicate !== null) return fail(duplicate);
  }

  // 9. 引用完整性 —— 漏了就会导入一堆孤儿数据
  const exerciseIds = new Set(exercises.value.map((exercise) => exercise.id));
  const sessionIds = new Set(sessions.value.map((session) => session.id));
  const sessionExerciseIds = new Set(
    sessionExercises.value.map((sessionExercise) => sessionExercise.id),
  );

  for (let i = 0; i < sessionExercises.value.length; i += 1) {
    const sessionExercise = sessionExercises.value[i];
    const label = `data.sessionExercises 第 ${i + 1} 条`;
    if (!sessionIds.has(sessionExercise.sessionId)) {
      return fail(
        `${label} 的 sessionId ${JSON.stringify(sessionExercise.sessionId)} 在 data.sessions 里找不到对应的训练记录（引用完整性）`,
      );
    }
    if (!exerciseIds.has(sessionExercise.exerciseId)) {
      return fail(
        `${label} 的 exerciseId ${JSON.stringify(sessionExercise.exerciseId)} 在 data.exercises 里找不到对应的动作（引用完整性）`,
      );
    }
  }

  for (let i = 0; i < sets.value.length; i += 1) {
    const set = sets.value[i];
    if (!sessionExerciseIds.has(set.sessionExerciseId)) {
      return fail(
        `data.sets 第 ${i + 1} 条的 sessionExerciseId ${JSON.stringify(set.sessionExerciseId)} 在 data.sessionExercises 里找不到对应的动作记录（引用完整性）`,
      );
    }
  }

  // 10. 返回规范化过的对象，input 里多出来的字段一律不透传
  return {
    ok: true,
    backup: {
      format: BACKUP_FORMAT,
      version,
      schemaVersion: schemaVersion.value,
      exportedAt: exportedAt.value,
      data: {
        exercises: exercises.value,
        sessions: sessions.value,
        sessionExercises: sessionExercises.value,
        sets: sets.value,
      },
    },
  };
}
