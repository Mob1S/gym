import { createContext, useContext, type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { statusBarStyle, useTheme } from './theme';

/**
 * 统一的页面外壳：主题背景色 + 状态栏 + 安全区。
 *
 * 在做这个组件之前，每个屏幕各自 `useSafeAreaInsets` 再手拼 padding，
 * 十一处各写一遍 —— 少写一处的表现就是内容钻进状态栏里。收进来之后
 * 「别忘记让出状态栏」这件事不再依赖记性。
 */

/**
 * 底部标签栏占用的高度，由标签页布局填进来。
 *
 * **为什么自己建一个 Context，而不是复用 React Navigation 的
 * `useBottomTabBarHeight()`：** 那个 hook 以及它背后的 Context 模块并不在
 * 已安装的依赖里 —— expo-router 把整套 React Navigation **内联**在自己的
 * `build/` 目录下，只能靠 `expo-router/build/...` 这种深层路径去够。那种路径
 * 是包的内部实现，升级时随时可能变；而且它的入口文件会引到 `.ts` 源码，
 * Metro 打包时未必处理得了。为了一个内边距承担这个风险不划算。
 *
 * 自己建一个只有十几行的 Context，行为完全可控，也不依赖任何内部路径。
 */
const TabBarHeightContext = createContext<number>(0);

/**
 * 把标签栏高度提供给子树。只有标签页布局需要包这一层。
 *
 * @param props.children 标签页子树
 * @param props.height 标签栏实际占用的高度（应已包含底部安全区）
 * @returns 带上标签栏高度的子树
 */
export function TabBarHeightProvider({
  children,
  height,
}: {
  children: ReactNode;
  height: number;
}) {
  return (
    <TabBarHeightContext.Provider value={height}>
      {children}
    </TabBarHeightContext.Provider>
  );
}

/** `Screen` 的入参 */
export interface ScreenProps {
  children: ReactNode;
  /**
   * 顶部是否让出状态栏高度。
   *
   * 标签页与自绘顶栏的页面（记录页、总结页）用默认的 `true`；用原生导航栏的
   * 页面（历史详情、动作进步）必须传 `false` —— 导航栏已经让过一次，
   * 再让一次就是双倍留白。
   */
  edgeToEdgeTop?: boolean;
  /** 内容是否横向留白。整屏滚动的图表类页面可以自带内边距，这时传 false */
  padded?: boolean;
  /** 额外样式，用来覆盖背景色或加外层布局 */
  style?: ViewStyle;
}

/**
 * 页面外壳。
 *
 * @param props.children 页面内容
 * @param props.edgeToEdgeTop 顶部是否自己让出状态栏，默认 `true`
 * @param props.padded 是否加横向内边距，默认 `true`
 * @param props.style 额外样式
 * @returns 带主题背景、状态栏样式与安全区内边距的容器
 */
export function Screen({
  children,
  edgeToEdgeTop = true,
  padded = true,
  style,
}: ScreenProps) {
  const { palette, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  // 标签页填进来的标签栏高度；不在标签页里时是 0
  const tabBarHeight = useContext(TabBarHeightContext);

  return (
    <View
      style={[
        {
          flex: 1,
          backgroundColor: palette.bg,
          paddingTop: edgeToEdgeTop ? insets.top : 0,
          // 在标签页里让开标签栏；不在的话让开底部安全区，再垫一点呼吸空间，
          // 否则最后一行会紧贴屏幕下边缘
          paddingBottom:
            tabBarHeight > 0 ? tabBarHeight : insets.bottom + 16,
          paddingHorizontal: padded ? 20 : 0,
        },
        style,
      ]}
    >
      {/* 状态栏图标颜色跟着主题反转，否则暗色背景下图标会看不见 */}
      <StatusBar style={statusBarStyle(isDark)} />
      {children}
    </View>
  );
}
