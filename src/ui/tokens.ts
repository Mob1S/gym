/**
 * 与主题无关的度量尺度：间距、圆角、字号、字重、描边。
 *
 * 这些值在两套配色下完全一致，所以和颜色分开放在这里 —— 改配色不该动间距，
 * 调间距也不该碰颜色。
 */

/**
 * 间距梯度，4 的倍数。
 *
 * 全部间距只从这一组里取，不再出现 `padding: 14` 这种随手写的值 ——
 * 界面之所以会显得凌乱，多半就是因为同一层级的东西各用了不同的间距。
 */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  /** 大屏留白：空状态、总结页顶部这类需要「呼吸」的地方 */
  huge: 48,
} as const;

/** 圆角梯度。`pill` 专门给药丸形标签用，值是任意大数 */
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

/** 描边宽度。`hairline` 让分隔线在高分屏上仍是 1 物理像素 */
export const border = {
  hairline: 1,
  thick: 2,
} as const;

/**
 * 字号梯度。
 *
 * `display` 是记录页那个超大数字，`clock` 是休息计时 —— 两者都比正文大一个数量级，
 * 因为它们是「隔着一步远也要看清」的信息。
 */
export const fontSize = {
  /** 记录页的重量 / 次数大数字 */
  display: 84,
  /** 休息计时的钟面 */
  clock: 76,
  /** 统计块里的主数字 */
  stat: 30,
  /** 页面大标题 */
  h1: 30,
  /** 区块标题 */
  h2: 22,
  /** 列表行主文本、按钮 */
  title: 17,
  /** 正文 */
  body: 15,
  /** 次要说明、元信息 */
  caption: 13,
  /** 分组小标题、单位标注 —— 通常配 letterSpacing 一起用 */
  label: 11,
} as const;

/** 字重。只用这三档，避免出现半吊子的中间值 */
export const weight = {
  regular: '400',
  medium: '600',
  bold: '800',
} as const;

/** 中文标签配一点字距会更好读，尤其在全大写或小字号时 */
export const tracking = {
  /** 分组小标题 */
  label: 1.2,
  /** 大数字收紧，视觉上更结实 */
  display: -3,
  clock: -2,
  none: 0,
} as const;

/** 行高。中文正文需要比拉丁文更松一点才不挤 */
export const leading = {
  tight: 20,
  normal: 24,
  loose: 28,
} as const;
