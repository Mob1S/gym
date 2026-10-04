import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ClockIcon,
  DumbbellIcon,
  GearIcon,
  TabBarHeightProvider,
  TrendIcon,
  usePalette,
} from '../../src/ui';

/**
 * 标签栏给图标回调的入参。
 *
 * `color` 的类型必须是 `ColorValue` 而不是 `string`：标签栏推导出来的颜色类型是
 * `ColorValue`（可能是平台不透明色对象），标成 `string` 会在 `tabBarIcon` 上
 * 报类型不兼容。这里只在边界放宽一次，进去之后马上转成字符串交给 SVG。
 *
 * 不直接复用 `IconProps`：那个类型的 `color` 是必填的普通 prop，而标签栏回调
 * 还会多给 `focused` 与 `size`。
 */
interface TabIconProps {
  color: ColorValue;
}

/**
 * 标签栏的高度，**不含底部安全区**。
 *
 * 抽成常量是因为它有两处用途：一是设给标签栏自己，二是加上安全区之后告诉
 * `Screen` 该让开多少。两处各写一个字面量，改一处忘一处就会导致列表最后一行
 * 被标签栏永久遮住。
 */
const TAB_BAR_HEIGHT = 62;

/**
 * 底部标签栏：训练 / 历史 / 进步 / 设置。
 *
 * `headerShown: false` 是刻意的 —— 四个页面顶部都有自己的大标题，再叠一条系统
 * 导航栏就是两行标题。代价是页面拿不到导航栏让出的状态栏高度，由 `Screen`
 * 组件统一补回来。
 *
 * 标签栏本身自绘了**图标 + 文字**：只有文字时四个标签长得一样，扫视时认不出；
 * 图标是手绘的四个 SVG（见 `src/ui/icons.tsx`），不引图标库。
 *
 * @returns 四个标签页的容器
 */
export default function TabLayout() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  return (
    // 把标签栏实际占用的高度（含安全区）告诉子树，`Screen` 才能正确地让开它
    <TabBarHeightProvider height={TAB_BAR_HEIGHT + insets.bottom}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: palette.accent,
          tabBarInactiveTintColor: palette.textFaint,
          tabBarStyle: {
            backgroundColor: palette.surface,
            borderTopColor: palette.border,
            borderTopWidth: 1,
            // 暗色主题下默认高度偏矮，加一点让图标和文字都松快些
            height: TAB_BAR_HEIGHT,
            paddingTop: 6,
          },
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: '训练',
            tabBarIcon: ({ color }: TabIconProps) => (
              <DumbbellIcon color={String(color)} />
            ),
          }}
        />
        <Tabs.Screen
          name="history"
          options={{
            title: '历史',
            tabBarIcon: ({ color }: TabIconProps) => (
              <ClockIcon color={String(color)} />
            ),
          }}
        />
        <Tabs.Screen
          name="progress"
          options={{
            title: '进步',
            tabBarIcon: ({ color }: TabIconProps) => (
              <TrendIcon color={String(color)} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: '设置',
            tabBarIcon: ({ color }: TabIconProps) => (
              <GearIcon color={String(color)} />
            ),
          }}
        />
      </Tabs>
    </TabBarHeightProvider>
  );
}
