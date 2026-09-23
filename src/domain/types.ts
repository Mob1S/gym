/**
 * 动作库里的一个动作。
 *
 * 预置动作与用户自建动作共用这张表，只有 `isCustom` 区分 —— 备份导出时两者
 * 都要带上，换设备后自建动作才不会丢。
 */
export interface Exercise {
  id: string;
  name: string;
  /** 肌群（胸/背/腿/肩/手臂/核心）；不在这个枚举里的排到最后 */
  muscleGroup: string | null;
  equipment: string | null;
  /** true = 用户自建；false = 预置 */
  isCustom: boolean;
  /** 归档的动作不在动作列表里出现，但历史记录仍引用得到它 */
  isArchived: boolean;
  createdAt: number;
}

/** 一次训练。`finishedAt` 为 null 即「正在进行中」 */
export interface WorkoutSession {
  id: string;
  name: string | null;
  startedAt: number;
  /** 结束时间；null 表示这场还没结束 */
  finishedAt: number | null;
  note: string | null;
}

/** 一次训练里的一个动作（练了什么 + 排第几）。**组挂在它下面**，不是挂在动作上 */
export interface SessionExercise {
  id: string;
  /** 属于哪一场训练。注意组记录引用的是本表的 id，不是 `exerciseId` */
  sessionId: string;
  /** 指向动作库里的动作 */
  exerciseId: string;
  /** 在这一场里的顺序，从 0 开始；界面按它排列 */
  position: number;
  note: string | null;
}

/**
 * 一组记录。**记录的原子单位**：完成即落盘的那一条就是它。
 *
 * 记录界面会为「下一组」预先建一条 `isCompleted: false` 的占位 —— 界面靠
 * 找这条占位来确定当前该记哪一组，所以它必须存在（详见 `store/activeSession.ts`）。
 */
export interface SetEntry {
  id: string;
  /** 指向 `SessionExercise.id`（不是 `exerciseId`）—— 两者都是字符串 id，写错了 tsc 不报错 */
  sessionExerciseId: string;
  /** 在这个动作里的第几组，从 0 开始 */
  position: number;
  /** 重量（kg） */
  weight: number;
  reps: number;
  isCompleted: boolean;
  /** 本组做完后休息了多久（秒）。NULL 表示还没结束那次休息，或这是最后一组 */
  restSeconds: number | null;
  /** 休息开始的时间戳。非 NULL 表示正在休息中 */
  restStartedAt: number | null;
  completedAt: number | null;
}

/**
 * 算容量负荷/1RM 所需的**最小**组形状。
 *
 * 单独定义它是为了让 `domain/metrics.ts` 不依赖完整的 `SetEntry` ——
 * 进步页折算曲线时手里只有「重量+次数」几个数，不必为了算容量伪造一个完整记录。
 */
export interface SetLike {
  /** 重量（kg） */
  weight: number;
  reps: number;
  /** 未完成的组不计入容量负荷 */
  isCompleted: boolean;
}
