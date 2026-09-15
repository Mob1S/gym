import { ScrollView, StyleSheet, Text, View } from 'react-native';

export default function SettingsTab() {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>设置</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>组间休息的一般参考</Text>
        <Text style={styles.line}>· 多关节动作（深蹲、卧推、硬拉等）：2 – 3 分钟</Text>
        <Text style={styles.line}>· 单关节动作（弯举、侧平举等）：1 – 2 分钟</Text>
        <Text style={styles.note}>
          以上是 ACSM 立场声明给出的一般区间，仅供参考。
          本 App 不会用它做任何自动计算 —— 训练后只比较你自己这次的次数变化。
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 16 },
  title: { fontSize: 24, fontWeight: '700' },
  card: { backgroundColor: '#f4f5f7', borderRadius: 12, padding: 16, gap: 6 },
  cardTitle: { fontSize: 15, fontWeight: '700', marginBottom: 4 },
  line: { fontSize: 14, color: '#4b5058' },
  note: { fontSize: 12, color: '#8a8f98', marginTop: 8, lineHeight: 18 },
});
