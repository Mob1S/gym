import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { usePalette } from './theme';
import { border, radius, space } from './tokens';

/** `Card` 的入参 */
export interface CardProps {
  children: ReactNode;
  /**
   * 视觉层级。
   *
   * `surface`（默认）是内容卡片；`sunken` 用在需要「凹进去」的位置，
   * 比如记录页那个可拖动的数值区。
   */
  tone?: 'surface' | 'sunken';
  /** 强调描边。用在「这是当前选中项」或「这是本次重点」上 */
  highlighted?: boolean;
  /** 额外样式 */
  style?: ViewStyle;
}

/**
 * 表面卡片：App 里一切「成块的内容」的容器。
 *
 * 层级靠**亮度差 + 一条描边**表达，不靠阴影 —— 暗色主题下阴影几乎看不见，
 * 而描边在两种主题下都稳定。这也是仪表盘该有的质感：边界清晰，不发虚。
 *
 * @param props.children 卡片内容
 * @param props.tone 表面层级，默认 `surface`
 * @param props.highlighted 是否加一圈强调色描边，默认否
 * @param props.style 额外样式（覆盖内边距、方向等）
 * @returns 卡片容器
 */
export function Card({
  children,
  tone = 'surface',
  highlighted = false,
  style,
}: CardProps) {
  const palette = usePalette();

  return (
    <View
      style={[
        {
          backgroundColor:
            tone === 'sunken' ? palette.surfaceSunken : palette.surface,
          borderRadius: radius.lg,
          padding: space.lg,
          borderWidth: border.hairline,
          borderColor: highlighted ? palette.accent : palette.border,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
