import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';

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
import { Card, Screen, Text, space, usePalette } from '../../src/ui';

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

/**
 * 动作进步详情页：横向三张卡，同一个动作的最大重量 / 估算 1RM / 总容量。
 *
 * 三张卡的措辞是刻意不同的（「最好」/「最好」/「最高」）：容量属于训练量，
 * 不是力量成绩，把它也说成「最好」会让人以为容量越大就代表越强。
 *
 * 横向分页本身在屏幕上没有任何可点之处，所以底下那排小圆点不是装饰，
 * 它是这一页唯一的导航提示。
 *
 * 这一页纯只读：路由参数 `id` 是 exercise.id，直接查库，不碰 `activeSession` ——
 * 训练中切过来看历史成绩不该打断正在记的那一场。
 *
 * @returns 三张卡加底部分页点；动作没有记录时是一句提示
 */
export default function ExerciseProgressScreen() {
  const exec = useDatabase();
  const { id } = useLocalSearchParams<{ id: string }>();
  // 屏宽即每张卡的宽度，横向分页的落点就是它
  const { width } = useWindowDimensions();
  // 绑定了当前主题的样式。这一屏顶部用原生导航栏，所以 `Screen` 要 edgeToEdgeTop={false}
  const styles = useExerciseStyles();

  // 动作名（设进导航栏标题）；库里查不到时为 null，标题退回「进步」
  const [exerciseName, setExerciseName] = useState<string | null>(null);
  const [points, setPoints] = useState<ProgressPoint[]>([]);
  // 取过一次数才置真。没有它就无法区分「还在查」和「这个动作确实没记录」，
  // 两者都会是空数组，界面却该长得完全不同
  const [loaded, setLoaded] = useState(false);
  // 当前横滑到第几张卡，只用来点亮底下的小圆点
  const [page, setPage] = useState(0);

  // 取「动作名 + 这个动作的全部已完成组」，两者并发。`cancelled` 是防竞态的：
  // 快速返回再进另一个动作时，先发的那次请求可能后到，不挡住它就会把上一个
  // 动作的曲线画在这一页上
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

  // 三张卡共用的汇总（各指标的最值、以及 e1RM 的缺席次数）。只有 points 变了
  // 才重算，它同时被下面 cards 和 e1RM 那张卡的脚注用到
  const summary = useMemo(() => summarizeProgress(points), [points]);

  // 把汇总摊成三张卡的显示模型。整块交给 useMemo 是因为每次 render 都重建这个
  // 数组的话，里面每个对象都是新的，三张图会跟着白白重画
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

  // 横轴两端的日期，贴在图下面当刻度标签。图本身不带日期轴，只有这两个端点
  // 能告诉用户「这条线横跨了多长时间」
  const firstAt = points.length > 0 ? points[0].startedAt : null;
  const lastAt = points.length > 0 ? points[points.length - 1].startedAt : null;

  if (!loaded) {
    return (
      <Screen edgeToEdgeTop={false} padded={false}>
        <View style={styles.center}>
          <Text variant="body" color="textMuted">
            载入中…
          </Text>
        </View>
      </Screen>
    );
  }

  if (points.length === 0) {
    return (
      <Screen edgeToEdgeTop={false} padded={false}>
        <View style={styles.center}>
          <Stack.Screen options={{ title: exerciseName ?? '进步' }} />
          <Text variant="title" color="textMuted">
            这个动作还没有记录
          </Text>
          <Text variant="caption" color="textFaint">
            练过一次之后这里就会有曲线
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen edgeToEdgeTop={false} padded={false}>
      {/* 标题用动作名：这一页看的全是同一个动作的数据 */}
      <Stack.Screen options={{ title: exerciseName ?? '进步' }} />

      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) => {
          // 用「偏移量 ÷ 屏宽」四舍五入反推页码，而不是自己维护一份滚动状态：
          // `pagingEnabled` 保证停下来时的落点必然落在整数页上
          setPage(Math.round(event.nativeEvent.contentOffset.x / width));
        }}
      >
        {cards.map((card) => {
          const hasPoint = card.series.some((value) => value !== null);
          return (
            <View key={card.key} style={[styles.page, { width }]}>
              <Card style={{ gap: space.sm }}>
                <View style={styles.cardHead}>
                  <Text variant="title">{card.title}</Text>
                  <Text variant="caption" color="textMuted" numberOfLines={1}>
                    {card.badge}
                  </Text>
                </View>

                {/* 这张卡的核心数字：给到 40px，是整页最该被看见的东西 */}
                <View style={styles.valueRow}>
                  <Text variant="numeric" style={styles.cardValue}>
                    {card.value}
                  </Text>
                  <Text variant="caption" color="textMuted">
                    {card.unit}
                  </Text>
                </View>

                {card.note ? (
                  <Text variant="caption" color="textMuted">
                    {card.note}
                  </Text>
                ) : null}

                {hasPoint ? (
                  <TrendChart
                    values={card.series}
                    highlightIndex={indexOfMax(card.series)}
                    showAxis
                    height={180}
                  />
                ) : (
                  <Text variant="caption" color="textMuted">
                    还没有记录
                  </Text>
                )}

                {firstAt !== null && lastAt !== null ? (
                  <View style={styles.xaxis}>
                    <Text variant="label" color="textFaint">
                      {formatDate(firstAt)}
                    </Text>
                    <Text variant="label" color="textFaint">
                      {formatDate(lastAt)}
                    </Text>
                  </View>
                ) : null}

                {/* e1RM 缺点的解释只在这一张卡上出现 —— 另两张永远没有缺点 */}
                {card.key === 'oneRepMax' && summary.missingOneRepMaxCount > 0 ? (
                  <Text variant="caption" color="textMuted">
                    有 {summary.missingOneRepMaxCount} 次训练没有可用于换算的组（次数 &gt; 10）
                  </Text>
                ) : null}

                {points.length === 1 ? (
                  <Text variant="caption" color="textMuted">
                    再练一次就能看到走势
                  </Text>
                ) : null}
              </Card>
            </View>
          );
        })}
      </ScrollView>

      {/* 分页指示不是装饰：横向滑动本身没有任何提示，没有它用户不知道旁边还有两张。
          当前页那一条拉长成短横，比单纯变色更容易看出「一共三张、现在是第一张」 */}
      <View style={styles.dots}>
        {cards.map((card, index) => (
          <View
            key={card.key}
            style={[styles.dot, index === page ? styles.dotActive : null]}
          />
        ))}
      </View>
    </Screen>
  );
}

/**
 * 这一屏用到的样式。
 *
 * 写成 hook 而不是模块级常量：颜色来自主题，模块级常量在模块加载时就固化了。
 *
 * @returns 绑定了当前主题的样式对象
 */
function useExerciseStyles() {
  const palette = usePalette();

  return useMemo(
    () => ({
      center: {
        flex: 1,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        gap: space.sm,
      },

      page: { padding: space.lg },
      cardHead: {
        flexDirection: 'row' as const,
        alignItems: 'baseline' as const,
        justifyContent: 'space-between' as const,
        gap: space.sm,
      },

      valueRow: {
        flexDirection: 'row' as const,
        alignItems: 'baseline' as const,
        gap: space.xs,
      },
      // 40 比统计块的 30 更大：这一页只有一张卡，它就是主角
      cardValue: { fontSize: 40, color: palette.text },

      xaxis: {
        flexDirection: 'row' as const,
        justifyContent: 'space-between' as const,
      },

      dots: {
        flexDirection: 'row' as const,
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
        gap: space.sm,
        paddingBottom: space.xl,
      },
      dot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: palette.borderStrong,
      },
      // 当前页拉长成短横，一眼能看出「一共三张、现在第一张」
      dotActive: { width: 22, backgroundColor: palette.accent },
    }),
    [palette],
  );
}
