import { useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';

import { buildChartGeometry } from '../lib/chartGeometry';

interface TrendChartProps {
  /**
   * 每个下标对应一次训练。`null` = 那一次没有可画的点（e1RM 曲线上「整场次数
   * 都 > 10」的训练就是这种）—— 线从两侧直接连过去，不补 0、不补估算。
   */
  values: (number | null)[];
  /** 高亮的下标（最好那一次），画成绿色实心；null 表示不高亮 */
  highlightIndex?: number | null;
  /** true = 带横向刻度线（详情页大图）；false = 列表行的迷你走势 */
  showAxis?: boolean;
  height?: number;
}

/**
 * 一条折线 + 每个点一个圆点。详情页的大图和列表行的迷你走势共用它 ——
 * 两者的核心是同一个形状，只是尺寸和有没有刻度线不同。
 *
 * **宽度靠 `onLayout` 量出来，不能写死。** 用固定 viewBox 加
 * `preserveAspectRatio="none"` 拉伸的话，圆点会被拉成椭圆（真机上很明显）。
 */
export function TrendChart({
  values,
  highlightIndex = null,
  showAxis = false,
  height = 180,
}: TrendChartProps) {
  const [width, setWidth] = useState(0);

  const geometry = useMemo(
    () =>
      width > 0
        ? buildChartGeometry(values, {
            width,
            height,
            // 带刻度线的图上下要多留一点，否则贴边的圆点会被裁掉
            padding: showAxis ? 16 : 6,
          })
        : null,
    [values, width, height, showAxis],
  );

  const handleLayout = (event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  };

  return (
    <View style={{ height }} onLayout={handleLayout}>
      {geometry && geometry.dots.length > 0 ? (
        <Svg width={width} height={height}>
          {showAxis ? (
            <Line
              x1={0}
              y1={height - 1}
              x2={width}
              y2={height - 1}
              stroke="#e3e5e9"
              strokeWidth={1}
            />
          ) : null}

          {geometry.polyline ? (
            <Polyline
              points={geometry.polyline}
              fill="none"
              stroke="#2b7fff"
              strokeWidth={showAxis ? 2.5 : 2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}

          {geometry.dots.map((dot) => {
            const highlighted = dot.index === highlightIndex;
            return (
              <Circle
                key={dot.index}
                cx={dot.x}
                cy={dot.y}
                r={highlighted ? 5 : showAxis ? 3.5 : 3}
                fill={highlighted ? '#34c759' : '#2b7fff'}
              />
            );
          })}
        </Svg>
      ) : null}
    </View>
  );
}
