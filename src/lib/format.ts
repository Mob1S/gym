/** 下标即 `getDay()` 的返回值：0 = 周日，1 = 周一 …… 6 = 周六 */
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * `9月16日 周三`
 *
 * 全程用本地时区的 getter，绕开 `toLocaleDateString` 在 Hermes 上的地区差异 ——
 * 同一份代码在不同手机上会排出不同格式，是那种只在别人机器上复现的 bug。
 */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${
    WEEKDAY_LABELS[date.getDay()]
  }`;
}

/** `09:05` —— 必须补零，否则 9 点 5 分会写成 `9:5` */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * 训练是什么时候开始的：`今天 15:20` / `昨天 19:30` / `9月16日 19:30`。
 *
 * 「今天 / 昨天」是为了让用户一眼认出主页那个「继续」按钮说的是哪一场 ——
 * 他打开 App 时心里想的正是「这是刚才那场，还是昨天那场」。
 *
 * `now` 可传入是为了可测：不传就用真实时间。
 */
export function formatDateTime(
  timestamp: number,
  now: number = Date.now(),
): string {
  const days = calendarDaysBetween(now, timestamp);
  if (days === 0) return `今天 ${formatTime(timestamp)}`;
  if (days === 1) return `昨天 ${formatTime(timestamp)}`;
  return `${formatDate(timestamp).split(' ')[0]} ${formatTime(timestamp)}`;
}

/**
 * 按「日历天」算差，而不是按 24 小时。
 *
 * 23:50 练完、次日 00:10 打开 App，两者只差 20 分钟但确实跨了一天，
 * 那时说「昨天」才对。做法是把两个时间戳都抹到当天零点再相减。
 * `Math.round` 兜住夏令时导致的 ±1 小时偏差（中国没有夏令时，但别依赖这个）。
 */
function calendarDaysBetween(now: number, then: number): number {
  const a = new Date(now);
  const b = new Date(then);
  const startOfA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const startOfB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((startOfA - startOfB) / 86400000);
}
