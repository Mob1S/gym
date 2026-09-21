export interface ChartSize {
  width: number;
  height: number;
  /** 四周留白，免得圆点被裁掉一半 */
  padding: number;
}

export interface ChartDot {
  /** 在 values 里的下标 */
  index: number;
  x: number;
  y: number;
  value: number;
}

export interface ChartGeometry {
  /** 直接喂给 SVG `Polyline` 的 points；有效点少于 2 个时是空串（不画线） */
  polyline: string;
  dots: ChartDot[];
  min: number;
  max: number;
}

/**
 * 把一串数值摊成折线图的坐标。
 *
 * 三条规则都是有原因的，不是随手写的：
 *
 * - `null` 表示「那一次训练没有可画的点」（e1RM 曲线上整场次数都 > 10 的情况），
 *   但它**仍然占一个横向位置**。不给它留位置的话，后面的点会往左挤，x 轴就和
 *   日期对不上了 —— 那比缺一个点更糟。
 * - 所有值一样（或只有一个点）时 `max === min`，直接做比例映射会除以 0。这种
 *   情况把点放在垂直中央。真机上一条竖线、或者 NaN 坐标，就是这么来的。
 * - 有效点少于 2 个时不画线：一个点连不成线，画出来只是一段长度为 0 的折线。
 */
export function buildChartGeometry(
  values: (number | null)[],
  size: ChartSize,
): ChartGeometry {
  const valid = values
    .map((value, index) => ({ value, index }))
    .filter(
      (item): item is { value: number; index: number } => item.value !== null,
    );

  if (valid.length === 0) {
    return { polyline: '', dots: [], min: 0, max: 0 };
  }

  const numbers = valid.map((item) => item.value);
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);

  const innerWidth = Math.max(0, size.width - size.padding * 2);
  const innerHeight = Math.max(0, size.height - size.padding * 2);
  // 只有一个横向位置时把它放中间，别贴着左边
  const step = values.length > 1 ? innerWidth / (values.length - 1) : 0;

  const dots: ChartDot[] = valid.map((item) => ({
    index: item.index,
    x: size.padding + step * item.index,
    y:
      max === min
        ? size.padding + innerHeight / 2
        : size.padding + innerHeight * (1 - (item.value - min) / (max - min)),
    value: item.value,
  }));

  return {
    polyline:
      dots.length >= 2 ? dots.map((dot) => `${dot.x},${dot.y}`).join(' ') : '',
    dots,
    min,
    max,
  };
}

/**
 * 找出最大值在序列里的下标，跳过 `null`。
 *
 * 卡上那个绿色的高亮点就是它。写成函数而不是在页面里 `Math.max(...)`，是因为
 * 散开展开到 `Math.max` 上会把 `null` 当成 0，而「整场算不出 e1RM」绝不能
 * 变成「这一场是 0」。
 */
export function indexOfMax(values: (number | null)[]): number | null {
  let bestIndex: number | null = null;
  let bestValue = -Infinity;

  values.forEach((value, index) => {
    if (value === null) return;
    if (value > bestValue) {
      bestValue = value;
      bestIndex = index;
    }
  });

  return bestIndex;
}
