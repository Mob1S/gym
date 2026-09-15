import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

/**
 * 临时占位页。
 *
 * 存在的唯一目的是让 `/session/[id]` 这个路由成立，这样 expo-router 的
 * typedRoutes 才会把它生成进 `.expo/types/router.d.ts`，否则训练页里的
 * `router.push(`/session/${id}`)` 会过不了 tsc，真机上点了也会落到空路由。
 *
 * Task 8 会用真正的「聚焦当前组」记录界面整个替换掉这个文件。
 */
export default function SessionPlaceholder() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>训练已开始</Text>
      <Text style={styles.hint}>session id：{id}</Text>
      <Text style={styles.hint}>记录界面将在 Task 8 实现</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 24,
  },
  title: { fontSize: 20, fontWeight: '700' },
  hint: { fontSize: 13, color: '#8a8f98' },
});
