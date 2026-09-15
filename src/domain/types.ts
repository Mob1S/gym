export interface Exercise {
  id: string;
  name: string;
  muscleGroup: string | null;
  equipment: string | null;
  isCustom: boolean;
  isArchived: boolean;
  createdAt: number;
}

export interface WorkoutSession {
  id: string;
  name: string | null;
  startedAt: number;
  finishedAt: number | null;
  note: string | null;
}

export interface SessionExercise {
  id: string;
  sessionId: string;
  exerciseId: string;
  position: number;
  note: string | null;
}

export interface SetEntry {
  id: string;
  sessionExerciseId: string;
  position: number;
  weight: number;
  reps: number;
  isCompleted: boolean;
  /** 本组做完后休息了多久（秒）。NULL 表示还没结束那次休息，或这是最后一组 */
  restSeconds: number | null;
  /** 休息开始的时间戳。非 NULL 表示正在休息中 */
  restStartedAt: number | null;
  completedAt: number | null;
}

export interface SetLike {
  weight: number;
  reps: number;
  isCompleted: boolean;
}
