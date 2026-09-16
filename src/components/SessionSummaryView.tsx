import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { totalVolumeLoad } from '../domain/metrics';
import { buildRestFeedback, type RestFeedback } from '../domain/restAdvice';
import type { WorkoutSession } from '../domain/types';
import { useDatabase } from '../repositories/database';
import { getExercise } from '../repositories/exerciseRepo';
import { getSession, listSessionExercises } from '../repositories/sessionRepo';
import { listSets } from '../repositories/setRepo';

interface ExerciseSummary {
  name: string;
  /** 已完成的组的次数，按组顺序。界面必须原样展示这个数组 */
  repsList: number[];
  totalSets: number;
  volume: number;
  feedback: RestFeedback | null;
}

interface SessionSummaryViewProps {
  sessionId: string;
}

/**
 * 一次训练的回顾内容：三个统计数字 +「组间休息回顾」列表。
 *
 * 训练总结页与历史详情页共用这一套渲染 —— 同一场训练，练完当下看到的和以后
 * 翻回来看的必须是同一份东西，所以这里只读、不写、不结束训练。
 *
 * 这一屏只做展示，不做判断 —— 休息提示的规则全部在 `src/domain/restAdvice.ts`，
 * 数据访问全部经过仓储层，界面不 import `src/db/`、不写 SQL。
 *
 * 这里的休息回顾是**粗略参考**，不是科学结论：只比较本次训练内首组与末组的
 * 次数差异。所以每个动作卡片第一行必须原样显示次数数组，用户才能自己核对。
 *
 * e1RM 在 v1 不显示（M4 才做），这里连算都不算。
 *
 * 组件只负责内容：滚动容器与安全区由使用它的页面负责（两个页面的外壳不同）。
 */
export function SessionSummaryView({ sessionId }: SessionSummaryViewProps) {
  const exec = useDatabase();

  const [session, setSession] = useState<WorkoutSession | null>(null);
  const [summaries, setSummaries] = useState<ExerciseSummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      const sessionExercises = await listSessionExercises(exec, sessionId);
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

      const current = await getSession(exec, sessionId);
      if (!cancelled) {
        setSession(current);
        setSummaries(result);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [exec, sessionId]);

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

  // 数据没回来之前不渲染内容：否则空态文案「这次训练还没有完成的组」会先闪一下，
  // 再被真实的数据顶掉。
  if (!loaded) {
    return <Text style={styles.hint}>载入中…</Text>;
  }

  return (
    <View style={styles.content}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  hint: { textAlign: 'center', color: '#8a8f98', marginTop: 40 },

  content: { gap: 14 },

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
});
