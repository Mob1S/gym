import { Tabs } from 'expo-router';

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
