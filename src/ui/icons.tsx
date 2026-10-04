import Svg, { Circle, Line, Path } from 'react-native-svg';

/**
 * 底部标签栏的四个图标。
 *
 * **手绘而不是引图标库。** `@expo/vector-icons` 会带进整套字体文件（约 1MB 起），
 * 而这个 App 一共只需要四个图标；`expo-symbols` 只有 iOS 有，Android 上要么
 * 空着要么另画一套。四个 path 换零依赖和两平台一致，这笔账很划算。
 *
 * 统一 24×24 viewBox、2 宽描边、圆头圆角 —— 尺寸和笔触一致，四个图标并排才像
 * 一套东西。颜色由调用方传入（选中态换强调色）。
 */

/** 全部图标共用的入参 */
export interface IconProps {
  /** 笔触颜色 */
  color: string;
  /** 边长，默认 24 */
  size?: number;
  /** 描边宽度，默认 2。选中/未选中不该改粗细，否则图标会「跳」 */
  strokeWidth?: number;
}

/**
 * 训练：一根杠铃。
 *
 * 中间横杆 + 两侧各一大一小两片杠铃片，是这个 App 最直白的隐喻。
 *
 * @param props 颜色与尺寸
 * @returns 杠铃图标
 */
export function DumbbellIcon({ color, size = 24, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* 横杆 */}
      <Line
        x1={7}
        y1={12}
        x2={17}
        y2={12}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      {/* 内侧两片 */}
      <Line
        x1={7}
        y1={8}
        x2={7}
        y2={16}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <Line
        x1={17}
        y1={8}
        x2={17}
        y2={16}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      {/* 外侧两片 */}
      <Line
        x1={3.5}
        y1={9.5}
        x2={3.5}
        y2={14.5}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <Line
        x1={20.5}
        y1={9.5}
        x2={20.5}
        y2={14.5}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/**
 * 历史：钟面 + 逆时针回拨箭头的简化形状。
 *
 * 只用钟面：加箭头在这个尺寸下会糊成一团。钟面本身就是「过去发生过的事」。
 *
 * @param props 颜色与尺寸
 * @returns 时钟图标
 */
export function ClockIcon({ color, size = 24, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle
        cx={12}
        cy={12}
        r={8.5}
        stroke={color}
        strokeWidth={strokeWidth}
      />
      {/* 时针与分针：指向 10 点方向，不是为了显示某个具体时间，
          只是让两根针不对称，一眼能看出是钟 */}
      <Path
        d="M12 7.5V12l3.2 2"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * 进步：一条向上的折线 + 末端的点。
 *
 * 折线刻意的「先平后陡」，比一条直线更像真实的进步曲线。
 *
 * @param props 颜色与尺寸
 * @returns 折线图标
 */
export function TrendIcon({ color, size = 24, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3.5 16.5l5-5 3.5 3.5 8-8"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 末端实心点：标出「现在在哪」 */}
      <Circle cx={20} cy={7} r={2} fill={color} />
    </Svg>
  );
}

/**
 * 设置：一个齿轮。
 *
 * 简化的六齿齿轮 —— 真画满齿在这个尺寸下会变成一团噪点，所以只保留轮廓 +
 * 中心圆孔，齿用短线段表示。
 *
 * @param props 颜色与尺寸
 * @returns 齿轮图标
 */
export function GearIcon({ color, size = 24, strokeWidth = 2 }: IconProps) {
  // 六个齿，每 60° 一个。用极坐标现算，避免手写十二个坐标出错
  const teeth = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    const inner = 6.2;
    const outer = 9.4;
    return {
      x1: 12 + Math.cos(angle) * inner,
      y1: 12 + Math.sin(angle) * inner,
      x2: 12 + Math.cos(angle) * outer,
      y2: 12 + Math.sin(angle) * outer,
    };
  });

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle
        cx={12}
        cy={12}
        r={6.2}
        stroke={color}
        strokeWidth={strokeWidth}
      />
      <Circle
        cx={12}
        cy={12}
        r={2.2}
        stroke={color}
        strokeWidth={strokeWidth}
      />
      {teeth.map((t, i) => (
        <Line
          key={i}
          x1={t.x1}
          y1={t.y1}
          x2={t.x2}
          y2={t.y2}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      ))}
    </Svg>
  );
}
