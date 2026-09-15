import { findStaleRest, isStaleRest, STALE_REST_THRESHOLD_MS } from './rest';
import type { SetEntry } from './types';

const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1000;

function makeSet(overrides: Partial<SetEntry> = {}): SetEntry {
  return {
    id: 's1',
    sessionExerciseId: 'se1',
    position: 0,
    weight: 100,
    reps: 5,
    isCompleted: true,
    restSeconds: null,
    restStartedAt: null,
    completedAt: NOW,
    ...overrides,
  };
}

describe('isStaleRest', () => {
  it('当前没在休息（restStartedAt 为 null）返回 false', () => {
    expect(isStaleRest(null, NOW)).toBe(false);
  });

  it('刚开始的休息不算陈旧', () => {
    expect(isStaleRest(NOW - 5_000, NOW)).toBe(false);
  });

  it('休息了 29 分钟仍在阈值内', () => {
    expect(isStaleRest(NOW - 29 * MINUTE, NOW)).toBe(false);
  });

  it('正好 30 分钟不算陈旧（判断是严格大于）', () => {
    expect(isStaleRest(NOW - STALE_REST_THRESHOLD_MS, NOW)).toBe(false);
  });

  it('超过 30 分钟 1 毫秒即算陈旧', () => {
    expect(isStaleRest(NOW - STALE_REST_THRESHOLD_MS - 1, NOW)).toBe(true);
  });

  it('隔夜的休息算陈旧', () => {
    expect(isStaleRest(NOW - 14 * 60 * MINUTE, NOW)).toBe(true);
  });
});

describe('findStaleRest', () => {
  it('没有正在进行的休息时返回 undefined', () => {
    const sets = [makeSet({ restStartedAt: null })];
    expect(findStaleRest(sets, NOW)).toBeUndefined();
  });

  it('休息时间正常的组不算陈旧', () => {
    const sets = [makeSet({ restStartedAt: NOW - 90 * 1000 })];
    expect(findStaleRest(sets, NOW)).toBeUndefined();
  });

  it('未完成的组即便带着时间戳也跳过', () => {
    const sets = [
      makeSet({ isCompleted: false, restStartedAt: NOW - 60 * MINUTE }),
    ];
    expect(findStaleRest(sets, NOW)).toBeUndefined();
  });

  it('能找出那段跑过头的休息', () => {
    const sets = [
      makeSet({ id: 'done', restStartedAt: null }),
      makeSet({ id: 'resting', position: 1, restStartedAt: NOW - 8 * 60 * MINUTE }),
      makeSet({ id: 'pending', position: 2, isCompleted: false, restStartedAt: null }),
    ];
    expect(findStaleRest(sets, NOW)?.id).toBe('resting');
  });

  it('多段休息里只命中真正跑过头的那一段', () => {
    const sets = [
      makeSet({ id: 'fresh', restStartedAt: NOW - 2 * MINUTE }),
      makeSet({ id: 'stale', position: 1, restStartedAt: NOW - 2 * 60 * MINUTE }),
    ];
    // 只有 stale 超阈值，fresh 不该被误伤
    expect(findStaleRest(sets, NOW)?.id).toBe('stale');
  });
});
