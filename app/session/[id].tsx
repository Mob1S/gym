import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { Stepper } from '../../src/components/Stepper';
import type { SetEntry } from '../../src/domain/types';
import { useDatabase } from '../../src/repositories/database';
import { getLastPerformance } from '../../src/repositories/setRepo';
import { useActiveSession } from '../../src/store/activeSession';

/**
 * 核心记录界面：一次只聚焦「当前这一组」。
 *
 * 设计要点：整屏只有一个大数字对（重量 × 次数）和一个主按钮。用户在健身房
 * 单手、喘着气、屏幕可能被汗糊住，任何需要「找」的交互都是失败设计。改动数值
 * 用 44pt 的加减按钮，不做键盘输入。
 *
 * 数据流全部经过 store 与仓储层：`completeCurrentSet` 会先把用户填的数值写库、
 * 再标记完成、再开始休息计时、并预建下一组 —— 也就是「完成即落盘」，中途杀掉
 * App 也不会丢已经做完的组。
 */
export default function SessionScreen() {
  const exec = useDatabase();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { session, exercises, currentIndex, resume, completeCurrentSet } =
    useActiveSession();

  const [weight, setWeight] = useState(20);
  const [reps, setReps] = useState(8);
  const [lastPerformance, setLastPerformance] = useState<SetEntry[]>([]);

  // 从训练页跳进来时 store 里已经有 session；但如果 App 被强杀后用深链直接
  // 打开这个路由，store 是空的，得自己把库里的未结束训练捡回来。
  useEffect(() => {
    if (!session || session.id !== id) {
      void resume(exec);
    }
  }, [exec, id, resume, session]);

  const current = exercises[currentIndex];
  const currentSets = current?.sets ?? [];
  const pending: SetEntry | undefined = useMemo(
    () => currentSets.find((s) => !s.isCompleted),
    [currentSets],
  );

  // 预填：优先沿用上一组刚做完的数值（同一动作内重量通常不变），
  // 没有上一组时才退回这一组自己在库里的默认值。
  useEffect(() => {
    if (!pending) return;
    const previousDone = [...currentSets].reverse().find((s) => s.isCompleted);
    setWeight(previousDone?.weight ?? pending.weight);
    setReps(previousDone?.reps ?? pending.reps);
  }, [pending?.id, currentSets]);

  // 「上次第 N 组：X kg × Y」提示。第三个参数必须是**当前** session id，
  // 仓储层用它把当前这场训练排除掉，否则会拿今天的记录当「上次」。
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    (async () => {
      const last = await getLastPerformance(
        exec,
        current.sessionExercise.exerciseId,
        id,
      );
      if (!cancelled) setLastPerformance(last);
    })();
    return () => {
      cancelled = true;
    };
  }, [current?.sessionExercise.exerciseId, exec, id]);

  if (!session || session.id !== id) {
    return (
      <View style={styles.container}>
        <Text style={styles.hint}>载入中…</Text>
      </View>
    );
  }

  if (!current) {
    return (
      <View style={styles.container}>
        <Text style={styles.hint}>这次训练还没有动作</Text>
      </View>
    );
  }

  const completedCount = currentSets.filter((s) => s.isCompleted).length;
  const setNumber = completedCount + 1;
  const plannedSets = lastPerformance.length || 3;
  const lastSamePosition = lastPerformance[completedCount];

  const handleComplete = async () => {
    try {
      await completeCurrentSet(exec, weight, reps);
    } catch (e) {
      // 这一步是「完成即落盘」的唯一入口，写库失败必须让用户知道，
      // 否则他会以为这一组已经记下了。Alert 不阻断下一组的操作。
      Alert.alert('这一组没能存进数据库', e instanceof Error ? e.message : String(e));
      return;
    }
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      // 无振动马达的设备上忽略
    }
  };

  // 误触「结束训练」会让人以为记录丢了，必须二次确认。
  // 无论用户选哪一项，已完成的组早就落盘了，不会丢。
  //
  // 这里回退到上一屏（训练页）而不是跳总结页：总结页是 Task 10 的路由，
  // 现在还不存在，`router.replace('/session/summary/...')` 既过不了 typedRoutes
  // 的 tsc 检查，真机上也会落到空路由。等 Task 10 建出总结页后，这里改成
  // `router.replace({ pathname: '/session/summary/[id]', params: { id } })`，
  // 并把 endWorkout(exec) 接在跳转之前。
  const handleFinish = () => {
    Alert.alert('结束这次训练？', '已经记录的组都会保留。', [
      { text: '继续练', style: 'cancel' },
      {
        text: '结束',
        style: 'destructive',
        onPress: () => router.back(),
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.exerciseName}>{current.exerciseName}</Text>
        <Text style={styles.setCounter}>
          第 {setNumber}
          {setNumber <= plannedSets ? ` / ${plannedSets}` : ''} 组
        </Text>
      </View>

      {lastSamePosition ? (
        <Text style={styles.lastHint}>
          上次第 {completedCount + 1} 组：{lastSamePosition.weight} kg ×{' '}
          {lastSamePosition.reps}
        </Text>
      ) : null}

      <View style={styles.bigRow}>
        <Text style={styles.bigNumber}>{weight}</Text>
        <Text style={styles.bigUnit}>kg</Text>
        <Text style={styles.bigTimes}>×</Text>
        <Text style={styles.bigNumber}>{reps}</Text>
      </View>

      <View style={styles.steppers}>
        <Stepper label="重量" value={weight} step={2.5} min={0} onChange={setWeight} />
        <Stepper label="次数" value={reps} step={1} min={1} onChange={setReps} />
      </View>

      <Pressable style={styles.completeButton} onPress={handleComplete}>
        <Text style={styles.completeButtonText}>✓　完成这组</Text>
      </Pressable>

      <Pressable style={styles.finishButton} onPress={handleFinish}>
        <Text style={styles.finishButtonText}>结束训练</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  exerciseName: { fontSize: 22, fontWeight: '700' },
  setCounter: { fontSize: 14, color: '#8a8f98' },
  lastHint: { fontSize: 13, color: '#8a8f98', textAlign: 'center' },
  bigRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  bigNumber: { fontSize: 56, fontWeight: '800', letterSpacing: -2 },
  bigUnit: { fontSize: 20, fontWeight: '600', color: '#8a8f98' },
  bigTimes: { fontSize: 24, color: '#8a8f98', marginHorizontal: 6 },
  steppers: { flexDirection: 'row', justifyContent: 'space-around' },
  completeButton: {
    backgroundColor: '#2b7fff',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
  },
  completeButtonText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  finishButton: {
    backgroundColor: '#eceef2',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  finishButtonText: { color: '#4b5058', fontSize: 14, fontWeight: '600' },
  hint: { textAlign: 'center', color: '#8a8f98', marginTop: 40 },
});
