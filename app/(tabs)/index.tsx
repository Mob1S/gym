import { View, Text, StyleSheet } from 'react-native';

export default function TrainTab() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>训练</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '600' },
});
