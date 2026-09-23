import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { totalVolumeLoad } from '../domain/metrics';
import { buildRestFeedback, type RestFeedback } from '../domain/restAdvice';
import type { WorkoutSession } from '../domain/types';
import { useDatabase } from '../repositories/database';
import { getExercise } from '../repositories/exerciseRepo';
import { getSession, listSessionExercises } from '../repositories/sessionRepo';
import { listSets } from '../repositories/setRepo';

/** 一个动作在这场训练里的汇总，界面上一一对应成一张卡片 */
interface ExerciseSummary {
  /** 动作名；动作记录查不到时退化成「未知动作」 */
  name: string;
  /** 已完成的组的次数，按组顺序。界面必须原样展示这个数组 */
  repsList: number[];
  /** 已完成的组数；记录界面预建的占位组不算在内 */
  totalSets: number;
  /** 总容量 = Σ(重量 × 次数)，单位 kg */
  volume: number;
  /** 休息复盘结论；组数不足 3 组时为 null，界面显示「暂不判断」 */
  feedback: RestFeedback | null;
}

/** SessionSummaryView 的入参 */
interface SessionSummaryViewProps {
  /** 要回顾的那次训练的 id（`WorkoutSession.id`） */
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
 *
 * @param props.sessionId 要回顾的那次训练的 id。训练总结页传当前这场训练的 id，
 *   历史详情页传列表里点进来的那一场 —— 同一个 id 渲染出来的必须是同一份东西
 *
 * 交互陷阱：组件只读不写，不会结束训练、不会改任何数据，也没有「关闭/返回」按钮，
 * 那些都由外面的页面负责。sessionId 一变（包括首帧的空串）就重跑一遍加载。
 */
export function SessionSummaryView({ sessionId }: SessionSummaryViewProps) {
  // 数据库执行器。Provider 在库就绪之前不放行子树，所以这里拿到的一定非空，
  // 不需要判空；它在整个 App 生命周期里只被赋值一次，不会引起下面的 effect 重跑。
  const exec = useDatabase();

  // 训练本体，用来算时长（结束时间戳 − 开始时间戳）
  const [session, setSession] = useState<WorkoutSession | null>(null);
  // 每个动作的汇总，只含已完成的组；空数组 = 这场训练一组都没练成
  const [summaries, setSummaries] = useState<ExerciseSummary[]>([]);
  // 载入完成标记。没有它的话，空态文案「这次训练还没有完成的组」会先闪一下
  const [loaded, setLoaded] = useState(false);

  // 按 sessionId 读一遍数据。cancelled 标记是为了防止旧的异步结果回来覆盖新数据
  // —— 用户快速从一场训练翻到另一场时，先发的那个查询可能后返回。
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

  // 三个统计数字从上面两份数据推出来：只要汇总或训练本体变了就重算一次，
  // 不做第二份 state，免得两份数据对不上。
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
