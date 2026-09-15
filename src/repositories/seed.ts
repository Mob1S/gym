export interface SeedExercise {
  name: string;
  muscleGroup: string;
  equipment: string;
}

export const SEED_EXERCISES: SeedExercise[] = [
  // 腿
  { name: '深蹲', muscleGroup: '腿', equipment: '杠铃' },
  { name: '前蹲', muscleGroup: '腿', equipment: '杠铃' },
  { name: '硬拉', muscleGroup: '腿', equipment: '杠铃' },
  { name: '罗马尼亚硬拉', muscleGroup: '腿', equipment: '杠铃' },
  { name: '腿举', muscleGroup: '腿', equipment: '器械' },
  { name: '腿屈伸', muscleGroup: '腿', equipment: '器械' },
  { name: '腿弯举', muscleGroup: '腿', equipment: '器械' },
  { name: '保加利亚分腿蹲', muscleGroup: '腿', equipment: '哑铃' },
  { name: '箭步蹲', muscleGroup: '腿', equipment: '哑铃' },
  { name: '站姿提踵', muscleGroup: '腿', equipment: '器械' },
  { name: '坐姿提踵', muscleGroup: '腿', equipment: '器械' },
  { name: '臀推', muscleGroup: '腿', equipment: '杠铃' },

  // 胸
  { name: '卧推', muscleGroup: '胸', equipment: '杠铃' },
  { name: '上斜卧推', muscleGroup: '胸', equipment: '杠铃' },
  { name: '下斜卧推', muscleGroup: '胸', equipment: '杠铃' },
  { name: '哑铃卧推', muscleGroup: '胸', equipment: '哑铃' },
  { name: '哑铃飞鸟', muscleGroup: '胸', equipment: '哑铃' },
  { name: '绳索夹胸', muscleGroup: '胸', equipment: '绳索' },
  { name: '双杠臂屈伸', muscleGroup: '胸', equipment: '自重' },
  { name: '俯卧撑', muscleGroup: '胸', equipment: '自重' },
  { name: '器械推胸', muscleGroup: '胸', equipment: '器械' },

  // 背
  { name: '引体向上', muscleGroup: '背', equipment: '自重' },
  { name: '高位下拉', muscleGroup: '背', equipment: '器械' },
  { name: '杠铃划船', muscleGroup: '背', equipment: '杠铃' },
  { name: '哑铃单臂划船', muscleGroup: '背', equipment: '哑铃' },
  { name: '坐姿绳索划船', muscleGroup: '背', equipment: '绳索' },
  { name: 'T 杠划船', muscleGroup: '背', equipment: '杠铃' },
  { name: '直臂下压', muscleGroup: '背', equipment: '绳索' },
  { name: '面拉', muscleGroup: '背', equipment: '绳索' },
  { name: '山羊挺身', muscleGroup: '背', equipment: '自重' },

  // 肩
  { name: '站姿推举', muscleGroup: '肩', equipment: '杠铃' },
  { name: '坐姿哑铃推举', muscleGroup: '肩', equipment: '哑铃' },
  { name: '侧平举', muscleGroup: '肩', equipment: '哑铃' },
  { name: '前平举', muscleGroup: '肩', equipment: '哑铃' },
  { name: '俯身飞鸟', muscleGroup: '肩', equipment: '哑铃' },
  { name: '反向蝴蝶机', muscleGroup: '肩', equipment: '器械' },
  { name: '耸肩', muscleGroup: '肩', equipment: '杠铃' },

  // 手臂
  { name: '杠铃弯举', muscleGroup: '手臂', equipment: '杠铃' },
  { name: '哑铃弯举', muscleGroup: '手臂', equipment: '哑铃' },
  { name: '锤式弯举', muscleGroup: '手臂', equipment: '哑铃' },
  { name: '牧师凳弯举', muscleGroup: '手臂', equipment: '器械' },
  { name: '绳索下压', muscleGroup: '手臂', equipment: '绳索' },
  { name: '仰卧臂屈伸', muscleGroup: '手臂', equipment: '杠铃' },
  { name: '过顶臂屈伸', muscleGroup: '手臂', equipment: '哑铃' },
  { name: '窄距卧推', muscleGroup: '手臂', equipment: '杠铃' },
  { name: '腕弯举', muscleGroup: '手臂', equipment: '哑铃' },

  // 核心
  { name: '卷腹', muscleGroup: '核心', equipment: '自重' },
  { name: '悬垂举腿', muscleGroup: '核心', equipment: '自重' },
  { name: '平板支撑', muscleGroup: '核心', equipment: '自重' },
  { name: '俄罗斯转体', muscleGroup: '核心', equipment: '哑铃' },
  { name: '绳索卷腹', muscleGroup: '核心', equipment: '绳索' },
  { name: '健腹轮', muscleGroup: '核心', equipment: '自重' },
];
