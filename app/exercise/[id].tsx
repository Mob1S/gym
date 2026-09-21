import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { TrendChart } from '../../src/components/TrendChart';
import {
  buildProgressPoints,
  summarizeProgress,
  toSeries,
  type ProgressMetric,
  type ProgressPoint,
} from '../../src/domain/progress';
import { indexOfMax } from '../../src/lib/chartGeometry';
import { formatDate, formatDateTime } from '../../src/lib/format';
import { useDatabase } from '../../src/repositories/database';
import { getExercise } from '../../src/repositories/exerciseRepo';
import { listCompletedSetPoints } from '../../src/repositories/progressRepo';

/** 一张卡要显示的东西。三张卡的措辞刻意不同，见设计文档 §3.3 */
interface CardModel {
  key: ProgressMetric;
  title: string;
  /** 头上那行小字 */
  badge: string;
  value: string;
  unit: string;
  /** 数字下面那行说明，没有就不显示 */
  note: string | null;
  series: (number | null)[];
}

export default function ExerciseProgressScreen() {
  const exec = useDatabase();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width } = useWindowDimensions();

  const [exerciseName, setExerciseName] = useState<string | null>(null);
  const [points, setPoints] = useState<ProgressPoint[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!id) {
      setLoaded(true);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      const [exercise, rows] = await Promise.all([
        getExercise(exec, id),
        listCompletedSetPoints(exec, id),
      ]);
      if (cancelled) return;
      setExerciseName(exercise?.name ?? null);
      setPoints(buildProgressPoints(rows));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [exec, id]);

  const summary = useMemo(() => summarizeProgress(points), [points]);

  const cards = useMemo<CardModel[]>(() => {
    return [
      {
        key: 'maxWeight',
        title: '最大重量',
        badge: summary.maxWeight
          ? `最好 · ${formatDateTime(summary.maxWeight.at)}`
          : '还没有记录',
        value: summary.maxWeight ? `${summary.maxWeight.value}` : '—',
        unit: 'kg',
        note: null,
        series: toSeries(points, 'maxWeight'),
      },
      {
        key: 'oneRepMax',
        title: '估算 1RM',
        badge: summary.bestOneRepMax
          ? `最好 · ${formatDateTime(summary.bestOneRepMax.at)}`
          : '还没有记录',
        value: summary.bestOneRepMax
          ? `${Math.round(summary.bestOneRepMax.value)}`
          : '—',
        unit: 'kg',
        // 这一行不是可选的：§5.4 要求界面上出现 e1RM 的地方必须标注是估算
        note: summary.bestOneRepMax
          ? `估算 · 仅供参考 · 来自 ${summary.bestOneRepMax.from.weight} kg × ${summary.bestOneRepMax.from.reps}`
          : '估算 · 仅供参考',
        series: toSeries(points, 'oneRepMax'),
      },
      {
        key: 'volumeLoad',
        title: '总容量',
        // 容量是训练量，不是力量成绩，所以这里写「最高」而不是「最好」
        badge: summary.maxVolumeLoad
          ? `最高 · ${formatDateTime(summary.maxVolumeLoad.at)}`
          : '还没有记录',
        value: summary.maxVolumeLoad
          ? `${Math.round(summary.maxVolumeLoad.value).toLocaleString('en-US')}`
          : '—',
        unit: 'kg',
        note: '总容量（重量 × 次数）· 只算已完成的组',
        series: toSeries(points, 'volumeLoad'),
      },
    ];
  }, [points, summary]);

  const firstAt = points.length > 0 ? points[0].startedAt : null;
  const lastAt = points.length > 0 ? points[points.length - 1].startedAt : null;

  if (!loaded) {
    return (
      <View style={styles.center}>
        <Text style={styles.hint}>载入中…</Text>
      </View>
    );
  }

  if (points.length === 0) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: exerciseName ?? '进步' }} />
        <Text style={styles.hint}>这个动作还没有记录</Text>
        <Text style={styles.subHint}>练过一次之后这里就会有曲线</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {/* 标题用动作名：这一页看的全是同一个动作的数据 */}
      <Stack.Screen options={{ title: exerciseName ?? '进步' }} />

      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) => {
          setPage(Math.round(event.nativeEvent.contentOffset.x / width));
        }}
      >
        {cards.map((card) => {
          const hasPoint = card.series.some((value) => value !== null);
          return (
            <View key={card.key} style={[styles.page, { width }]}>
              <View style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>{card.title}</Text>
                  <Text style={styles.cardBadge}>{card.badge}</Text>
                </View>

                <View style={styles.valueRow}>
                  <Text style={styles.cardValue}>{card.value}</Text>
                  <Text style={styles.cardUnit}>{card.unit}</Text>
                </View>

                {card.note ? <Text style={styles.cardNote}>{card.note}</Text> : null}

                {hasPoint ? (
                  <TrendChart
                    values={card.series}
                    highlightIndex={indexOfMax(card.series)}
                    showAxis
                    height={180}
                  />
                ) : (
                  <Text style={styles.cardNote}>还没有记录</Text>
                )}

                {firstAt !== null && lastAt !== null ? (
                  <View style={styles.xaxis}>
                    <Text style={styles.xaxisText}>{formatDate(firstAt)}</Text>
                    <Text style={styles.xaxisText}>{formatDate(lastAt)}</Text>
                  </View>
                ) : null}

                {/* e1RM 缺点的解释只在这一张卡上出现 —— 另两张永远没有缺点 */}
                {card.key === 'oneRepMax' && summary.missingOneRepMaxCount > 0 ? (
                  <Text style={styles.cardNote}>
                    有 {summary.missingOneRepMaxCount} 次训练没有可用于换算的组（次数 &gt; 10）
                  </Text>
                ) : null}

                {points.length === 1 ? (
                  <Text style={styles.cardNote}>再练一次就能看到走势</Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </ScrollView>

      {/* 分页指示不是装饰：横向滑动本身没有任何提示，没有它用户不知道旁边还有两张 */}
      <View style={styles.dots}>
        {cards.map((card, index) => (
          <View
            key={card.key}
            style={[styles.dot, index === page ? styles.dotActive : null]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  hint: { color: '#8a8f98' },
  subHint: { color: '#a8adb5', fontSize: 13 },

  page: { padding: 20 },
  card: { backgroundColor: '#f4f5f7', borderRadius: 14, padding: 16, gap: 8 },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  cardBadge: { fontSize: 12, color: '#8a8f98' },

  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  cardValue: { fontSize: 34, fontWeight: '800' },
  cardUnit: { fontSize: 15, color: '#4b5058' },

  cardNote: { fontSize: 12, color: '#8a8f98', lineHeight: 17 },

  xaxis: { flexDirection: 'row', justifyContent: 'space-between' },
  xaxisText: { fontSize: 11, color: '#a8adb5' },

  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, paddingBottom: 24 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#d8dbe0' },
  dotActive: { backgroundColor: '#2b7fff' },
});
