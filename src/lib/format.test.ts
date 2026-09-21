import { formatDate, formatDateTime, formatTime } from './format';

/** 固定一个「现在」，否则「今天/昨天」的断言会随真实日期漂移 */
const NOW = new Date(2026, 8, 21, 15, 36).getTime(); // 2026-09-21 15:36（月份 0 基）

/** `at(2026, 9, 21, 9, 5)` = 2026-09-21 09:05 本地时间 */
function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe('formatDate', () => {
  it('写成「月日 + 星期」', () => {
    // 2026-09-21 是星期一，往前推 5 天就是星期三
    expect(formatDate(at(2026, 9, 16, 19, 30))).toBe('9月16日 周三');
  });
});

describe('formatTime', () => {
  it('个位数的小时与分钟都要补零', () => {
    expect(formatTime(at(2026, 9, 21, 9, 5))).toBe('09:05');
  });

  it('下午用 24 小时制', () => {
    expect(formatTime(at(2026, 9, 21, 19, 30))).toBe('19:30');
  });
});

describe('formatDateTime', () => {
  it('当天说「今天」', () => {
    expect(formatDateTime(at(2026, 9, 21, 9, 5), NOW)).toBe('今天 09:05');
  });

  it('前一天说「昨天」', () => {
    expect(formatDateTime(at(2026, 9, 20, 23, 50), NOW)).toBe('昨天 23:50');
  });

  it('跨过零点就算「昨天」，而不是按 24 小时算', () => {
    // 差 20 分钟不到一天，但确实是昨天练的
    expect(formatDateTime(at(2026, 9, 20, 23, 59), NOW)).toBe('昨天 23:59');
  });

  it('再早写月日', () => {
    expect(formatDateTime(at(2026, 9, 16, 19, 30), NOW)).toBe('9月16日 19:30');
  });
});
