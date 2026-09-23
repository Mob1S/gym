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
 *
 * @param props.values 每个下标对应一次训练的值（y 轴量纲由调用方决定）；
 *   `null` 表示那一次没有可画的点，线直接跨过去
 * @param props.highlightIndex 要高亮的下标（最好那一次），画成绿色实心；
 *   null 或省略 = 不高亮
 * @param props.showAxis true = 底部多一条横向刻度线、点更大，详情页大图用；
 *   false（默认）= 列表行的迷你走势
 * @param props.height 图表高度，单位 px，默认 180；宽度不用传，组件自己量
 *
 * 交互陷阱：宽度还没量出来（首帧、或父容器尚未布局）时整块什么都不画 ——
 * 这是有意的，拿 0 当宽度去算坐标会得到一堆 NaN。
 */
export function TrendChart({
  values,
  highlightIndex = null,
  showAxis = false,
  height = 180,
}: TrendChartProps) {
  // 量出来的真实像素宽度。首帧必然是 0（onLayout 还没回调），
  // 所以下面算坐标前要先判 width > 0。
  const [width, setWidth] = useState(0);

  // 坐标只在宽度、数据、高度、有没有刻度线变化时重算。注意 values 是数组：
  // 调用方每次渲染现铺一个数组字面量的话，这个 memo 每次都会落空 —— 迷你走势
  // 一屏几十个，值得在这里留意一下。
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

  /**
   * 把容器量到的宽度存下来，触发一次重算坐标。
   *
   * @param event onLayout 事件，宽度取 `nativeEvent.layout.width`
   *   （dp，已经按屏幕密度换算过，和 Svg 的 width 同一套单位）
   */
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
