import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { keepScreenAwake } from '../../src/lib/keepAwake';
import { useDatabase } from '../../src/repositories/database';
import { useActiveSession } from '../../src/store/activeSession';

export default function TrainTab() {
  const exec = useDatabase();
  const router = useRouter();
  const { session, loading, startNew, resume } = useActiveSession();

  // App 被强杀或用户切走再回来时，库里可能还留着一条未结束的训练，
  // 进入训练页先把它捡回来，「继续上次训练」按钮才会自动出现。
  useEffect(() => {
    if (!session) {
      void resume(exec);
    }
  }, [exec, resume, session]);

  const handleStart = useCallback(async () => {
    await startNew(exec, null);
    const started = useActiveSession.getState().session;
    if (started) {
      await keepScreenAwake();
      router.push(`/session/${started.id}`);
    }
  }, [exec, router, startNew]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>训练</Text>

      {session ? (
        <Pressable
          style={styles.primaryButton}
          onPress={() => router.push(`/session/${session.id}`)}
        >
          <Text style={styles.primaryButtonText}>继续上次训练</Text>
        </Pressable>
      ) : null}

      <Pressable
        style={[styles.primaryButton, session ? styles.secondaryButton : null]}
        onPress={handleStart}
        disabled={loading}
      >
        <Text
          style={[
            styles.primaryButtonText,
            session ? styles.secondaryButtonText : null,
          ]}
        >
          {session ? '开始新训练' : '开始训练'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  primaryButton: {
    backgroundColor: '#2b7fff',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 32,
    minWidth: 220,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  secondaryButton: { backgroundColor: '#eceef2' },
  secondaryButtonText: { color: '#4b5058' },
});
