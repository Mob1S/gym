import { Stack } from 'expo-router';

import { DatabaseProvider } from '../src/repositories/database';

export default function RootLayout() {
  return (
    <DatabaseProvider>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        {/* 记录界面自绘顶部动作条，系统导航栏的 `session/[id]` 路由标题是纯噪音 */}
        <Stack.Screen name="session/[id]" options={{ headerShown: false }} />
        {/* 总结页同样自绘顶部的三个统计数字，导航栏只会白占一行高度 */}
        <Stack.Screen
          name="session/summary/[id]"
          options={{ headerShown: false }}
        />
      </Stack>
    </DatabaseProvider>
  );
}
