import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDateTime } from '../../src/lib/format';
import { keepScreenAwake } from '../../src/lib/keepAwake';
import { describeExercises } from '../../src/lib/sessionLabel';
import { useDatabase } from '../../src/repositories/database';
import { useActiveSession } from '../../src/store/activeSession';

export default function TrainTab() {
  const exec = useDatabase();
  const router = useRouter();
  const { session, exercises, loading, startNew, resume, endWorkout } =
    useActiveSession();

  // 只有「还没结束」的才算当前训练，必须在 finishedAt 上判，而不是「有没有
  // session」—— 后者曾经让一场已经结束、只是还留在内存里的训练也长出一个
  // 「继续上次训练」按钮，点进去还能接着往里记组。
  //
  // 窄化成 `current` 而不是留一个 boolean：`session` 的类型是
  // `WorkoutSession | null`，从 boolean 变量推不出它非空，JSX 里直接写
  // `session.id` 过不了 tsc。
  const current =
    session !== null && session.finishedAt === null ? session : null;

  // App 被强杀或用户切走再回来时，库里可能还留着一条未结束的训练，
  // 进入训练页先把它捡回来，「继续上次训练」按钮才会自动出现。
  useEffect(() => {
    if (!session) {
      void resume(exec);
    }
  }, [exec, resume, session]);

  const openSession = useCallback(
    (id: string) => {
      void keepScreenAwake();
      // 必须用对象形式。expo-router 的 typedRoutes 对动态路由只生成
      // `/session/[id]` 这个字面量，没有 `/session/${string}` 模板，
      // 写成模板字符串过不了 tsc。
      router.push({ pathname: '/session/[id]', params: { id } });
    },
    [router],
  );

  const openCurrent = useCallback(async () => {
    const started = useActiveSession.getState().session;
    if (started) openSession(started.id);
  }, [openSession]);

  const handleStart = useCallback(async () => {
    const result = await startNew(exec, null);

    if (result === 'conflict') {
      // `startNew` 撞上未结束的训练时不新建，而是把那一场装进 store 并返回
      // 'conflict'。这里读的就是它 —— 弹窗里说的和待会儿进去的必须是同一场。
      const { session: blocked, exercises: blockedExercises } =
        useActiveSession.getState();
      if (!blocked) return;
      Alert.alert(
        '上一场训练还没结束',
        `${formatDateTime(blocked.startedAt)} · ${describeExercises(
          blockedExercises,
        )}`,
        [
          {
            text: '接着练',
            style: 'cancel',
            onPress: () => openSession(blocked.id),
          },
          {
            text: '结束它，开始新的',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                await endWorkout(exec);
                await startNew(exec, null);
                await openCurrent();
              })();
            },
          },
        ],
        // 点空白处 / 返回键 = 什么都不做。Android 上一个 Alert 最多三个按钮，
        // 布局固定是 [neutral, negative, positive]，硬塞第三个必然有一个落进
        // 最右那个加粗位置 —— 无论把「接着练」还是「结束它」放那儿都是误导，
        // 所以第三条路交给「不选」。
        { cancelable: true },
      );
      return;
    }

    await openCurrent();
  }, [endWorkout, exec, openCurrent, openSession, startNew]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>训练</Text>

      {current ? (
        <Pressable
          style={styles.primaryButton}
          onPress={() => openSession(current.id)}
        >
          <Text style={styles.primaryButtonText}>
            继续 {formatDateTime(current.startedAt)} 的训练
          </Text>
          <Text style={styles.resumeDetail}>{describeExercises(exercises)}</Text>
        </Pressable>
      ) : null}

      <Pressable
        style={[styles.primaryButton, current ? styles.secondaryButton : null]}
        onPress={handleStart}
        disabled={loading}
      >
        <Text
          style={[
            styles.primaryButtonText,
            current ? styles.secondaryButtonText : null,
          ]}
        >
          {current ? '开始新训练' : '开始训练'}
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
    gap: 4,
  },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  // 「继续」按钮上的第二行：说明这一场练到哪了，用半透明白压在主色上
  resumeDetail: { color: 'rgba(255,255,255,0.85)', fontSize: 13 },
  secondaryButton: { backgroundColor: '#eceef2' },
  secondaryButtonText: { color: '#4b5058' },
});
