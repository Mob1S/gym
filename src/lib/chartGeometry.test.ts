import { buildChartGeometry, indexOfMax } from './chartGeometry';

/** 固定一组尺寸，让断言里的坐标可以手算出来 */
const SIZE = { width: 200, height: 100, padding: 10 };
// innerWidth = 180，innerHeight = 80；3 个横向位置时 step = 90 → x = 10 / 100 / 190

describe('buildChartGeometry', () => {
  it('把最小值和最大值分别贴到上下留白处', () => {
    const geometry = buildChartGeometry([10, 20, 30], SIZE);

    expect(geometry.min).toBe(10);
    expect(geometry.max).toBe(30);
    expect(geometry.dots).toEqual([
      { index: 0, x: 10, y: 90, value: 10 },
      { index: 1, x: 100, y: 50, value: 20 },
      { index: 2, x: 190, y: 10, value: 30 },
    ]);
    expect(geometry.polyline).toBe('10,90 100,50 190,10');
  });

  it('null 仍然占一个横向位置，否则后面的点会和日期对不上', () => {
    const geometry = buildChartGeometry([10, null, 30], SIZE);

    // 中间那次训练没有点，但第三个点仍然落在 x = 190，不是往左挤到 100
    expect(geometry.dots.map((d) => d.x)).toEqual([10, 190]);
    expect(geometry.polyline).toBe('10,90 190,10');
  });

  it('所有值相同时放在垂直中央，不能除以 0', () => {
    const geometry = buildChartGeometry([5, 5, 5], SIZE);

    expect(geometry.dots.map((d) => d.y)).toEqual([50, 50, 50]);
    expect(geometry.polyline).toBe('10,50 100,50 190,50');
  });

  it('只有一个有效点时只画点、不画线', () => {
    const geometry = buildChartGeometry([42], SIZE);

    expect(geometry.dots).toEqual([{ index: 0, x: 10, y: 50, value: 42 }]);
    expect(geometry.polyline).toBe('');
  });

  it('一个有效点都没有时返回空，不抛异常', () => {
    expect(buildChartGeometry([null, null], SIZE)).toEqual({
      polyline: '',
      dots: [],
      min: 0,
      max: 0,
    });
  });

  it('空数组也是空的', () => {
    expect(buildChartGeometry([], SIZE).dots).toEqual([]);
  });
});

describe('indexOfMax', () => {
  it('跳过 null 找出最大值的下标', () => {
    expect(indexOfMax([3, null, 9, 4])).toBe(2);
  });

  it('并列时取靠前的那个', () => {
    expect(indexOfMax([7, 7])).toBe(0);
  });

  it('全是 null 时返回 null', () => {
    expect(indexOfMax([null, null])).toBeNull();
  });
});
