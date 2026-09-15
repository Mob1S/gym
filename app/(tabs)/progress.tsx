import { View, Text, StyleSheet } from 'react-native';

export default function ProgressTab() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>进步</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '600' },
});
