import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { totalVolumeLoad } from '../../../src/domain/metrics';
import {
  buildRestFeedback,
  type RestFeedback,
} from '../../../src/domain/restAdvice';
import type { WorkoutSession } from '../../../src/domain/types';
import { releaseScreenAwake } from '../../../src/lib/keepAwake';
import { useDatabase } from '../../../src/repositories/database';
import { getExercise } from '../../../src/repositories/exerciseRepo';
import {
  finishSession,
  getSession,
  listSessionExercises,
} from '../../../src/repositories/sessionRepo';
import { listSets } from '../../../src/repositories/setRepo';
import { useActiveSession } from '../../../src/store/activeSession';

interface ExerciseSummary {
  name: string;
  /** 已完成的组的次数，按组顺序。界面必须原样展示这个数组 */
  repsList: number[];
  totalSets: number;
  volume: number;
  feedback: RestFeedback | null;
}

/**
 * 训练总结页：一次训练结束后，把统计数字和「组间休息回顾」摊开给用户看。
 *
 * 这一屏只做展示，不做判断 —— 休息提示的规则全部在 `src/domain/restAdvice.ts`，
 * 数据访问全部经过仓储层，界面不 import `src/db/`、不写 SQL。
 *
 * 这里的休息回顾是**粗略参考**，不是科学结论：只比较本次训练内首组与末组的
 * 次数差异。所以每个动作卡片第一行必须原样显示次数数组，用户才能自己核对。
 *
 * e1RM 在 v1 不显示（M4 才做），这里连算都不算。
 */
export default function SummaryScreen() {
  const exec = useDatabase();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // 这个路由在 app/_layout.tsx 里设了 headerShown: false，没有导航栏帮忙让出
  // 状态栏，所以必须自己用 insets 把内容压下来。
  const insets = useSafeAreaInsets();

  const endWorkout = useActiveSession((s) => s.endWorkout);
  const reset = useActiveSession((s) => s.reset);

  const [session, setSession] = useState<WorkoutSession | null>(null);
  const [summaries, setSummaries] = useState<ExerciseSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      const sessionExercises = await listSessionExercises(exec, id);
      const result: ExerciseSummary[] = [];

      for (const se of sessionExercises) {
        const sets = await listSets(exec, se.id);
        // 只统计已完成的组：没做的那一组是记录界面预建的占位，不算训练量。
        const completed = sets.filter((s) => s.isCompleted);
        if (completed.length === 0) continue;

        const exercise = await getExercise(exec, se.exerciseId);
        const repsList = completed.map((s) => s.reps);
        const restList = completed.map((s) => s.restSeconds);

        result.push({
          name: exercise?.name ?? '未知动作',
          repsList,
          totalSets: completed.length,
          volume: totalVolumeLoad(completed),
          feedback: buildRestFeedback(repsList, restList),
        });
      }

      const current = await getSession(exec, id);
      if (!cancelled) {
        setSession(current);
        setSummaries(result);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [exec, id]);

  const totals = useMemo(() => {
    const totalSets = summaries.reduce((n, s) => n + s.totalSets, 0);
    const volume = summaries.reduce((n, s) => n + s.volume, 0);
    // 时长用结束时间戳 − 开始时间戳。还没写 finished_at 时（理论上不该出现，
    // 结束训练时 store 已经写过一次）退回「到现在为止」，好过显示 0 分钟。
    const endedAt = session?.finishedAt ?? Date.now();
    const minutes = session
      ? Math.max(0, Math.round((endedAt - session.startedAt) / 60000))
      : 0;
    return { totalSets, volume, minutes };
  }, [summaries, session]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // endWorkout 会结束进行中的休息并写入 finished_at。它只作用于 store 里
      // 那场训练，所以补一道兜底：强杀后经深链直接进这一屏时 store 是空的，
      // 光靠它 finished_at 永远不会写，训练页会一直显示「继续上次训练」。
      await endWorkout(exec);
      if (id && useActiveSession.getState().session?.id !== id) {
        await finishSession(exec, id, Date.now());
      }

      // `endWorkout` 会把刚结束的这场训练留在 store 里（finishedAt 非空），
      // 而训练页只看 session 是否存在就显示「继续上次训练」—— 不 reset 的话，
      // 保存完回到训练页仍会看到那个按钮，点进去是一场已经结束的训练。
      reset();
      releaseScreenAwake();
      router.replace('/(tabs)');
    } catch (e) {
      // 保存失败必须让用户知道，否则他会以为这次训练已经存好了。
      Alert.alert('没能保存这次训练', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.hint}>载入中…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.container,
        {
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 20,
        },
      ]}
    >
      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{totals.minutes}</Text>
          <Text style={styles.statLabel}>分钟</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{totals.totalSets}</Text>
          <Text style={styles.statLabel}>总组数</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{Math.round(totals.volume)}</Text>
          <Text style={styles.statLabel}>总容量 kg</Text>
        </View>
      </View>

      {/* 标题必须带「粗略参考」：这一屏不是科学建议，只是本次训练内的一次简单对比 */}
      <Text style={styles.sectionLabel}>组间休息回顾（粗略参考）</Text>

      {summaries.length === 0 ? (
        <Text style={styles.empty}>这次训练还没有完成的组</Text>
      ) : (
        summaries.map((s, index) => (
          <View key={`${s.name}-${index}`} style={styles.card}>
            {/* 第一行原样显示次数数组，用户能自己核对文案说得对不对 */}
            <View style={styles.cardHeader}>
              <Text style={styles.exerciseName} numberOfLines={1}>
                {s.name}
              </Text>
              <Text style={styles.repsArray}>{s.repsList.join(' / ')}</Text>
            </View>
            {s.feedback ? (
              <Text style={styles.feedback}>{s.feedback.message}</Text>
            ) : (
              <Text style={styles.feedbackMuted}>组数不足 3 组，暂不判断</Text>
            )}
          </View>
        ))
      )}

      <Pressable
        style={[styles.saveButton, saving ? styles.saveButtonDisabled : null]}
        onPress={() => {
          void handleSave();
        }}
        disabled={saving}
      >
        <Text style={styles.saveButtonText}>保存这次训练</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  container: { padding: 20, gap: 14 },
  hint: { textAlign: 'center', color: '#8a8f98', marginTop: 40 },

  statsRow: { flexDirection: 'row', gap: 10 },
  stat: {
    flex: 1,
    backgroundColor: '#f4f5f7',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  statValue: { fontSize: 20, fontWeight: '800' },
  statLabel: { fontSize: 11, color: '#8a8f98' },

  sectionLabel: {
    fontSize: 12,
    color: '#6b7280',
    letterSpacing: 0.6,
    marginTop: 6,
  },

  card: { backgroundColor: '#f4f5f7', borderRadius: 12, padding: 14, gap: 6 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
  },
  exerciseName: { flexShrink: 1, fontSize: 15, fontWeight: '600' },
  repsArray: { fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
  feedback: { fontSize: 13, color: '#4b5058', lineHeight: 19 },
  feedbackMuted: { fontSize: 13, color: '#a0a4ab' },
  empty: { color: '#8a8f98', fontSize: 13 },

  saveButton: {
    backgroundColor: '#16181d',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 10,
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
