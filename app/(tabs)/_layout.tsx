import { Tabs } from 'expo-router';

/**
 * 底部标签栏：训练 / 历史 / 进步 / 设置。
 *
 * `headerShown: false` 是刻意的 —— 四个页面顶部都有自己的大标题，再叠一条系统
 * 导航栏就是两行标题。代价是页面拿不到导航栏让出的状态栏高度，几个标签页都得
 * 自己引 `useSafeAreaInsets` 把内容压下来。
 *
 * @returns 四个标签页的容器
 */
export default function TabLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: '训练' }} />
      <Tabs.Screen name="history" options={{ title: '历史' }} />
      <Tabs.Screen name="progress" options={{ title: '进步' }} />
      <Tabs.Screen name="settings" options={{ title: '设置' }} />
    </Tabs>
  );
}
