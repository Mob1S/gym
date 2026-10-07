import { Stack } from 'expo-router';

import { DatabaseProvider } from '../src/repositories/database';
import { ThemePreferenceProvider } from '../src/store/themePreference';

/**
 * 全 App 唯一的根布局：套上 `DatabaseProvider`，再把五条路由挂进 `Stack`。
 *
 * `ThemePreferenceProvider` 必须包在 `DatabaseProvider` **之内** —— 主题偏好存在
 * 数据库里，它要读库。它负责把偏好注入到 `src/ui` 的 Context，让整个 App 的
 * `useTheme()` / `usePalette()` 都跟着变，所以必须在 `Stack` 之外。
 *
 * 每条路由的 `headerShown` / `title` 在这里一次定死，而不是各页面自己去关 ——
 * 记录页、总结页自绘了顶部内容，必须关掉导航栏；历史详情页、动作进度页顶部
 * 只有一行文字，交给原生导航栏反而白拿返回手势与安全区处理。
 *
 * @returns 包着数据库与主题偏好上下文的路由栈
 */
export default function RootLayout() {
  return (
    <DatabaseProvider>
      <ThemePreferenceProvider>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          {/* 记录界面自绘顶部动作条，系统导航栏的 `session/[id]` 路由标题是纯噪音 */}
          <Stack.Screen name="session/[id]" options={{ headerShown: false }} />
          {/* 总结页同样自绘顶部的三个统计数字，导航栏只会白占一行高度 */}
          <Stack.Screen
            name="session/summary/[id]"
            options={{ headerShown: false }}
          />
          {/* 历史详情页用原生导航栏：它自带返回手势与安全区处理，这一页顶部只有
              训练名和日期，不需要自绘顶栏 */}
          <Stack.Screen name="history/[id]" options={{ title: '训练详情' }} />
          {/* 动作进步曲线：用原生导航栏，标题由页面自己设成动作名 */}
          <Stack.Screen name="exercise/[id]" options={{ title: '进步' }} />
          {/* 计划列表与编辑：顶部只有标题（编辑页另加一个「保存」），
              交给原生导航栏白拿返回手势与安全区处理 */}
          <Stack.Screen name="plan/index" options={{ title: '训练计划' }} />
          <Stack.Screen name="plan/[id]" options={{ title: '编辑计划' }} />
          {/* 记录管理：CSV 导入与手动补记录共用一个路由（靠 `?mode=` 分），
              顶部只需要一行标题，交给原生导航栏白拿返回手势与安全区处理 */}
          <Stack.Screen name="import/index" options={{ title: '添加记录' }} />
        </Stack>
      </ThemePreferenceProvider>
    </DatabaseProvider>
  );
}
