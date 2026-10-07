/**
 * CSV 导入解析：把 Strong / Hevy / 训记 导出的 CSV 文本变成与来源无关的 `ImportedWorkout[]`。
 *
 * 纯函数：不碰数据库、不读时钟（时间戳全部由文本里的日期算出来），所以能在单测里随便跑。
 * 解析层**绝不猜**：认不出的行走 `skipped` 并带上文件里的真实行号，让预览页原样告诉用户，
 * 而不是悄悄塞一条错的进库。
 */

/** 与来源格式无关的中间结构。CSV 解析与手动补记录都产出它，落库只认它 */
export interface ImportedWorkout {
  startedAt: number;
  finishedAt: number;
  name: string | null;
  exercises: { name: string; sets: { weight: number; reps: number }[] }[];
}

export interface CsvParseResult {
  workouts: ImportedWorkout[];
  /** 读不懂的行：**文件里的真实行号**（从 1 开始，含表头）+ 原因 */
  skipped: { line: number; reason: string }[];
  /** 识别到的来源与用到的列名，预览页要写出来让用户确认 */
  detected: { source: CsvSource; columns: Record<string, string> };
  /**
   * 有多少行的重量原本是磅、被换算成了公斤。
   *
   * 必须由解析器**算出来**：换算之后公斤和磅在 `workouts` 里长得一模一样，
   * 事后从 weight 反推是不可能的。预览页要靠它写明「已把 N 行磅换算成公斤」——
   * 少数几磅的误差用户未必看得出，但 135 磅当成 135 kg 会直接毁掉进步曲线，
   * 所以这件事必须让用户看见。**没有磅时是 0，不是 undefined**。
   */
  poundsConverted: number;
}

/** 识别到的来源；`unknown` 表示列名谁都不像（多半是选错了文件） */
export type CsvSource = 'strong' | 'hevy' | 'xunji' | 'unknown';

/** 解析结果里的字段名（内部键），与三张映射表的键一一对应 */
const COLUMN_KEYS = ['date', 'name', 'exercise', 'weight', 'reps'] as const;
type ColumnKey = (typeof COLUMN_KEYS)[number];

/**
 * 四列必需；「训练名」缺失时退化成 `null`。
 * 「组序」不参与解析：三种来源的组序都有，但组的先后已经在文件行序里了，
 * 多读一列只会多一个坏数据的入口。
 */
const REQUIRED_COLUMN_KEYS: readonly ColumnKey[] = ['date', 'exercise', 'weight', 'reps'];

/**
 * 三种来源的列名映射表，按 App 里的原始写法写（方便对着真实的导出文件核对）。
 * 比对前会用 `normalizeHeaderCell` 把表里的名字和表头**同一套规则**处理一遍：
 * 表头那边去过空白后是 `exercisename`，表里若原样拿 `exercise name` 去比就永远匹配不上。
 */
const SOURCES: readonly { source: Exclude<CsvSource, 'unknown'>; columns: Record<ColumnKey, string> }[] = [
  {
    source: 'strong',
    columns: {
      date: 'date',
      name: 'workout name',
      exercise: 'exercise name',
      weight: 'weight',
      reps: 'reps',
    },
  },
  {
    source: 'hevy',
    columns: {
      date: 'start_time',
      name: 'title',
      exercise: 'exercise_title',
      weight: 'weight_kg',
      reps: 'reps',
    },
  },
  {
    source: 'xunji',
    columns: {
      date: '日期',
      name: '训练名称',
      exercise: '动作名称',
      weight: '重量(kg)',
      reps: '次数',
    },
  },
];

/** 磅 → 公斤的换算系数（国际磅定义，精确值） */
const POUND_IN_KG = 0.45359237;

/** 一场训练的时长兜底：只有一行数据时时长为 0，历史上会显示「0 分钟」 */
const MIN_WORKOUT_DURATION_MS = 60_000;

// ---------------------------------------------------------------------------
// 文本层面的脏数据
// ---------------------------------------------------------------------------

/**
 * 剥掉文件开头的 UTF-8 BOM。
 * 不剥的话首列名会变成 `'\uFEFFDate'`，规范化也去不掉它（BOM 在名字开头），
 * 三张映射表一个都匹配不上 —— 整份文件被判成「认不出」，用户只会看到
 * 「这个文件里没有能识别的训练记录」，根本猜不到是 BOM 干的。
 */
function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

/**
 * 全角 ASCII（Ａ-Ｚ、０-９、（）等）转半角。
 * 中文输入法或中文 App 导出时全角很常见，`６０ｋｇ` 与 `60kg` 不统一就会一个都认不出来；
 * 表头里的 `重量（kg）`（全角括号）与映射表里的 `重量(kg)` 也是靠这一步才对得上的。
 */
function toHalfWidth(text: string): string {
  return text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

interface CsvRecord {
  /** 这条记录的字段（引号与 `""` 转义已经还原） */
  fields: string[];
  /** 这条记录在**文件里的真实行号**，从 1 开始（含表头行） */
  line: number;
}

/**
 * 把整份文本切成记录，并记下每条记录真实的行号。
 *
 * 不能先按 `\n` 切再逐行分词：引号里的换行属于字段内容，先切行会把一条记录劈成两条，
 * 而且之后所有行的行号全部错位 —— skipped 报的行号就没法对着表格找了。
 * 所以这里用一次状态机扫全文，行号随扫描同步推进。
 *
 * 同时支持 `\r\n` / `\n` / `\r` 三种行尾：Windows 导出的 CSV 是 `\r\n`，
 * 把 `\r` 留在字段尾巴上会让 `8\r` 这种值解析失败，次数与重量会整列读不出来。
 */
function splitCsvLines(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1; // 正在扫描的物理行
  let recordLine = 1; // 当前记录起始的物理行

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // `""` 是字段内的一个字面引号，不是字段结束
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else if (ch === '\r' || ch === '\n') {
        // 引号内的换行是字段内容：统一成 \n（库里存 \r\n 会在界面上显示成方块），
        // 但行号照样要往前走，否则后面所有坏行报的行号都是错的
        if (ch === '\r' && text[i + 1] === '\n') i += 1;
        field += '\n';
        line += 1;
      } else {
        field += ch;
      }
      continue;
    }

    // 只有字段开头（前面是行首或分隔符）的引号才是「引号包裹」的开始。
    // 若把值中间的引号也当成开始，`60"` 这种脏值会把后面整个文件吞进一个字段里。
    if (ch === '"' && field === '') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      fields.push(field);
      field = '';
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      fields.push(field);
      records.push({ fields, line: recordLine });
      fields = [];
      field = '';
      line += 1;
      recordLine = line;
      continue;
    }
    field += ch;
  }

  // 文件末尾没有换行符时最后一条记录也要收；但结尾刚好是换行时不能凭空多出一条空记录
  if (field !== '' || fields.length > 0) {
    fields.push(field);
    records.push({ fields, line: recordLine });
  }

  return records;
}

/** 整行都是空白（空行、只有空格或制表符的行）：跳过，且**不算读不懂** */
function isBlankRecord(fields: string[]): boolean {
  return fields.every((value) => value.trim() === '');
}

/**
 * 表头规范化：全角转半角 + 去掉所有空白 + 转小写。
 * 不做这一步的话 `Weight` / `weight ` / `重量（kg）` 与映射表里的写法差一个字符就匹配不上，
 * 整份文件会被判成「认不出」。
 */
function normalizeHeaderCell(cell: string): string {
  return toHalfWidth(cell).replace(/\s+/g, '').toLowerCase();
}

/**
 * 判断一条记录是不是重复出现的表头行。
 * 有的导出工具分页时每页都写一遍表头，当成数据行会得到「重量读不出来」之类的一堆假报错。
 */
function isSameAsHeader(fields: string[], headerFields: string[]): boolean {
  if (fields.length !== headerFields.length) return false;
  return fields.every((value, i) => normalizeHeaderCell(value) === normalizeHeaderCell(headerFields[i]));
}

// ---------------------------------------------------------------------------
// 表头 → 来源与列下标
// ---------------------------------------------------------------------------

interface HeaderMatch {
  source: CsvSource;
  /** 字段名 → 它在表头里的下标；-1 表示没有这一列 */
  index: Record<ColumnKey, number>;
  /** 预览页要展示的列名，用文件里的原始写法（用户得能对着文件核对） */
  columns: Record<string, string>;
}

/**
 * 认来源：四列（日期 / 动作 / 重量 / 次数）全中才算这个来源，训练名可有可无。
 * 一张表只有三列中了两列时宁可判成「认不出」，也不能猜 —— 猜错列的结果是整库数据都错位。
 */
function locateColumns(headerCells: string[]): HeaderMatch {
  const normalized = headerCells.map(normalizeHeaderCell);

  for (const spec of SOURCES) {
    const index = { date: -1, name: -1, exercise: -1, weight: -1, reps: -1 } as Record<ColumnKey, number>;
    let complete = true;

    for (const key of COLUMN_KEYS) {
      const at = normalized.indexOf(normalizeHeaderCell(spec.columns[key]));
      index[key] = at;
      if (at < 0 && REQUIRED_COLUMN_KEYS.includes(key)) {
        complete = false;
        break;
      }
    }

    if (!complete) continue;

    const columns: Record<string, string> = {};
    for (const key of COLUMN_KEYS) {
      if (index[key] >= 0) columns[key] = headerCells[index[key]].trim();
    }

    return { source: spec.source, index, columns };
  }

  return { source: 'unknown', index: { date: -1, name: -1, exercise: -1, weight: -1, reps: -1 }, columns: {} };
}

/** 取第 i 个字段；列不存在（这行列数比表头少）时返回 undefined，交给调用方判成读不懂 */
function valueAt(fields: string[], i: number): string | undefined {
  if (i < 0 || i >= fields.length) return undefined;
  return fields[i];
}

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------

/** `2024-01-15 09:30:00` / `2024-01-15T09:30` / `2024/1/15 9:30`：四位年份在前，没有歧义 */
const YEAR_FIRST = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(AM|PM)?$/i;

/**
 * 美式的「月/日/年」：`1/15/2024 9:30 AM` / `01/15/2024 09:30`。
 *
 * 刻意按**月在前**解释：Strong 与 Hevy 都是美国 App，它们导出的就是月/日/年。
 * 于是 `15/1/2024`（日在前）会因为月 = 15 判为非法而进 skipped —— 这是**刻意的**：
 * 两种写法长得一样却含义相反，猜错会让整月的训练日期全错位，宁可让用户看到「第 N 行认不出来」。
 * 也因此不接受两位年份（`1/15/24`）：它和日/月/年的两位写法更容易混，没必要赌。
 */
const MONTH_FIRST = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(AM|PM)?$/i;

/**
 * 手动装配时间戳，**不走 `Date.parse`**：后者对 `2024-01-15 09:30:00` 这种无时区字符串
 * 在不同 JS 引擎上行为不一致（Hermes 与 V8 就不同），同一份 CSV 在手机上和在 Node 里
 * 可能差几个小时。这里用 `new Date(y, m-1, d, ...)` 按**本地时区**显式构造，行为可预期。
 *
 * @param meridiem 非空时按 12 小时制处理（AM/PM）
 * @returns 毫秒时间戳；字段越界或日期不存在（如 2 月 31 日）时返回 null
 */
function buildTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  meridiem: string | null,
): number | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (minute < 0 || minute > 59 || second < 0 || second > 59) return null;

  let hour24 = hour;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour24 = (hour % 12) + (/^pm$/i.test(meridiem) ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }

  const date = new Date(year, month - 1, day, hour24, minute, second);

  // 2 月 31 日这种不存在的日期会被 Date 悄悄滚到 3 月，那就是一条日期完全错误的记录
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return date.getTime();
}

/**
 * 日期文本 → 毫秒时间戳；认不出来返回 null（该行进 skipped）。
 *
 * 只有日期没有时间时取当天 **12:00**：零点最容易被时区处理推到前一天，
 * 一条 15 号的训练跑到 14 号去，用户会以为导入坏了。
 */
function parseDate(raw: string): number | null {
  const text = toHalfWidth(raw).trim();
  if (text === '') return null;

  const yearFirst = YEAR_FIRST.exec(text);
  if (yearFirst) {
    const [, year, month, day, hour, minute, second, meridiem] = yearFirst;
    return buildTimestamp(
      Number(year),
      Number(month),
      Number(day),
      hour === undefined ? 12 : Number(hour),
      minute === undefined ? 0 : Number(minute),
      second === undefined ? 0 : Number(second),
      meridiem ?? null,
    );
  }

  const monthFirst = MONTH_FIRST.exec(text);
  if (monthFirst) {
    const [, month, day, year, hour, minute, second, meridiem] = monthFirst;
    return buildTimestamp(
      Number(year),
      Number(month),
      Number(day),
      hour === undefined ? 12 : Number(hour),
      minute === undefined ? 0 : Number(minute),
      second === undefined ? 0 : Number(second),
      meridiem ?? null,
    );
  }

  return null;
}

/**
 * 本地时区的 `YYYY-MM-DD`，用来把行分组成训练。
 *
 * 刻意不用 `toISOString().slice(0, 10)`：它按 UTC 切日期，东八区晚上 8 点以后练的会被算到前一天，
 * 于是「同一天练的两场」被劈成两场、跨零点的一场反而并到一起。
 */
function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// 重量与次数
// ---------------------------------------------------------------------------

/**
 * 重量解析的结果。
 *
 * 多带回一个「原本是不是磅」不是为了好看：换算之后两者在结果里完全相同，
 * 而预览页要告诉用户「有 N 行是磅」。这个信息只有解析这一层有。
 */
type WeightResult = { kg: number; fromPounds: boolean } | null;

/**
 * 重量 → 公斤。`null` 表示读不懂（进 skipped），`0` 表示自重（是有效数据）。
 *
 * - 空 / `BW` / `自重` → 0：引体向上、俯卧撑这些动作在 CSV 里重量列就是空的，
 *   当成读不懂会把整行（含有效的次数）丢掉
 * - `kg`/`公斤` 去掉单位；`lb`/`lbs`/`磅` → × 0.45359237 后保留两位小数。
 *   磅绝不能静默当成公斤：135 磅读成 135 kg 会让进步曲线直接跳到一个不可能的数字
 * - 认不出的单位（如「斤」）返回 null，不做二次猜测
 */
function parseWeight(raw: string): WeightResult {
  const text = toHalfWidth(raw).trim().toLowerCase();

  if (text === '') return { kg: 0, fromPounds: false };
  if (text === 'bw' || text === 'bw.' || text === '自重' || text === '自身重量' || text === '身体重量') {
    return { kg: 0, fromPounds: false };
  }

  const matched = /^([+-]?\d+(?:\.\d+)?)\s*([a-z\u4e00-\u9fff]*)$/.exec(text);
  if (!matched) return null;

  const value = Number(matched[1]);
  if (!Number.isFinite(value)) return null;

  const unit = matched[2];
  if (unit === '' || unit === 'kg' || unit === 'kgs' || unit === '公斤' || unit === '千克') {
    return { kg: value, fromPounds: false };
  }
  if (unit === 'lb' || unit === 'lbs' || unit === 'pound' || unit === 'pounds' || unit === '磅') {
    return { kg: Math.round(value * POUND_IN_KG * 100) / 100, fromPounds: true };
  }

  return null;
}

/**
 * 次数必须是正整数，否则返回 null（进 skipped）。
 *
 * 次数会直接进容量负荷与 1RM 计算，猜错一次就是一条错的历史记录；
 * 所以 `8.5`、`八次`、`8 次`、`0`、负数一律不认，让用户自己回去改 CSV。
 */
function parseReps(raw: string): number | null {
  const text = toHalfWidth(raw).trim();
  if (!/^\d+$/.test(text)) return null;

  const value = Number(text);
  return value > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// 逐行解析与组装
// ---------------------------------------------------------------------------

interface ParsedRow {
  startedAt: number;
  name: string | null;
  exercise: string;
  weight: number;
  reps: number;
  /** 这一行的重量原本是磅（已换算）。汇总成预览页那句「已把 N 行磅换算成公斤」 */
  fromPounds: boolean;
}

type RowResult = { ok: true; row: ParsedRow } | { ok: false; reason: string };

/**
 * 解析一条数据行。任何一列读不懂就整行进 skipped 并给出**具体是哪一列**，
 * 一次只报一个原因（第一处失败就返回），否则一行会在预览里占好几条。
 */
function parseRow(fields: string[], index: Record<ColumnKey, number>): RowResult {
  const rawDate = valueAt(fields, index.date);
  if (rawDate === undefined) return { ok: false, reason: '这一行的列数比表头少，读不到「日期」列' };
  const startedAt = parseDate(rawDate);
  if (startedAt === null) return { ok: false, reason: `日期的格式认不出来（收到 \`${rawDate.trim()}\`）` };

  const rawExercise = valueAt(fields, index.exercise);
  if (rawExercise === undefined) return { ok: false, reason: '这一行的列数比表头少，读不到「动作名称」列' };
  const exercise = rawExercise.trim();
  if (exercise === '') return { ok: false, reason: '动作名称是空的' };

  const rawWeight = valueAt(fields, index.weight);
  if (rawWeight === undefined) return { ok: false, reason: '这一行的列数比表头少，读不到「重量」列' };
  const weight = parseWeight(rawWeight);
  if (weight === null) return { ok: false, reason: `重量的格式认不出来（收到 \`${rawWeight.trim()}\`）` };
  const rawReps = valueAt(fields, index.reps);
  if (rawReps === undefined) return { ok: false, reason: '这一行的列数比表头少，读不到「次数」列' };
  const reps = parseReps(rawReps);
  if (reps === null) return { ok: false, reason: `次数的格式认不出来（收到 \`${rawReps.trim()}\`）` };

  // 训练名可有可无：没有那一列、或者这一行是空的，都是 null（不是读不懂）
  const rawName = index.name >= 0 ? valueAt(fields, index.name) : undefined;
  const name = rawName === undefined ? null : rawName.trim() === '' ? null : rawName.trim();

  return {
    ok: true,
    row: {
      startedAt,
      name,
      exercise,
      weight: weight.kg,
      reps,
      fromPounds: weight.fromPounds,
    },
  };
}

interface WorkoutGroup {
  startedAt: number;
  finishedAt: number;
  name: string | null;
  /** 动作名 → 组；Map 保留插入顺序，也就是动作在文件里首次出现的顺序 */
  exercises: Map<string, { weight: number; reps: number }[]>;
}

/**
 * 按**本地日期**把行组装成训练。
 *
 * 用日期分组而不是「相邻两行时间差小于 N 小时」：后者会把跨零点的训练劈成两场，
 * 也会把隔天同一时间的两次训练并成一场 —— 只有日历日期能同时满足这两条。
 *
 * 组内 `startedAt` 取最早一行、`finishedAt` 取最晚一行；两者相同（只有一行，或所有行同一分钟）时
 * 兜底加 1 分钟，不然训练时长是 0，历史上会显示「0 分钟」。
 */
function buildWorkouts(rows: ParsedRow[]): ImportedWorkout[] {
  const groups = new Map<string, WorkoutGroup>();

  for (const row of rows) {
    const key = localDateKey(row.startedAt);
    let group = groups.get(key);
    if (!group) {
      group = { startedAt: row.startedAt, finishedAt: row.startedAt, name: null, exercises: new Map() };
      groups.set(key, group);
    }

    if (row.startedAt < group.startedAt) group.startedAt = row.startedAt;
    if (row.startedAt > group.finishedAt) group.finishedAt = row.startedAt;
    if (group.name === null && row.name !== null) group.name = row.name;

    const sets = group.exercises.get(row.exercise);
    if (sets) sets.push({ weight: row.weight, reps: row.reps });
    else group.exercises.set(row.exercise, [{ weight: row.weight, reps: row.reps }]);
  }

  return [...groups.values()]
    .map((group) => ({
      startedAt: group.startedAt,
      finishedAt: group.finishedAt > group.startedAt ? group.finishedAt : group.startedAt + MIN_WORKOUT_DURATION_MS,
      name: group.name,
      exercises: [...group.exercises.entries()].map(([name, sets]) => ({ name, sets })),
    }))
    // 越早的在前：历史列表与进步曲线都按时间排，导入的数组也按时间排
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * 解析一份 CSV 文本。
 *
 * 结构：剥 BOM → 切记录（带真实行号）→ 第一条非空行当表头 → 认来源 → 逐行取值 → 按日期组装。
 * 认不出的文件返回空结果而不是抛异常：选错文件是最常见的操作失误，界面靠
 * `detected.source === 'unknown'` 决定不给「确认导入」按钮。
 */
export function parseWorkoutCsv(text: string): CsvParseResult {
  const records = splitCsvLines(stripBom(text));

  // 表头 = 第一条不是空白的记录：文件前面有几行空行时不至于把空行当表头
  const headerRecord = records.find((record) => !isBlankRecord(record.fields));
  if (!headerRecord) {
    return { workouts: [], skipped: [], detected: { source: 'unknown', columns: {} }, poundsConverted: 0 };
  }

  const match = locateColumns(headerRecord.fields);
  if (match.source === 'unknown') {
    // 选错文件时不把每行都塞进 skipped：几十条「读不懂」会让用户以为文件坏了，
    // 其实是拿错了文件；界面只看 detected.source。
    return { workouts: [], skipped: [], detected: { source: 'unknown', columns: {} }, poundsConverted: 0 };
  }

  const rows: ParsedRow[] = [];
  const skipped: { line: number; reason: string }[] = [];

  for (const record of records) {
    if (record === headerRecord) continue;
    if (isBlankRecord(record.fields)) continue; // 空行不是「读不懂」
    if (isSameAsHeader(record.fields, headerRecord.fields)) continue; // 重复表头同理

    const parsed = parseRow(record.fields, match.index);
    if (parsed.ok) rows.push(parsed.row);
    else skipped.push({ line: record.line, reason: parsed.reason });
  }

  return {
    workouts: buildWorkouts(rows),
    skipped,
    detected: { source: match.source, columns: match.columns },
    // 只数成功的行：进 skipped 的那些没有进库，把它们算进换算提示只会让人困惑
    poundsConverted: rows.filter((row) => row.fromPounds).length,
  };
}
