import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { TrendChart } from '../../src/components/TrendChart';
import { buildProgressPoints, toSeries } from '../../src/domain/progress';
import { formatDate } from '../../src/lib/format';
import { useDatabase } from '../../src/repositories/database';
import {
  listCompletedSetPoints,
  listTrainedExercises,
  type CompletedSetPoint,
  type TrainedExercise,
} from '../../src/repositories/progressRepo';
import { Screen, Text, space, usePalette } from '../../src/ui';

/** 列表一行要显示的东西 */
interface ProgressRow {
  exerciseId: string;
  name: string;
  lastTrainedAt: number;
  /** 最近一次训练里最重的那一组 */
  lastTop: { weight: number; reps: number };
  /** 迷你走势：每次训练的最大重量 */
  spark: (number | null)[];
}

/**
 * 把「练过哪些动作」与「全部原始组」拼成列表行。
 *
 * 分组放在 JS 里做，而不是对每个动作查一次：首屏要画每个动作的迷你走势，
 * 本来就缺不了完整序列，一次全取再分组只有一个查询。
 *
 * 迷你走势用**最大重量**而不是 e1RM：它每次训练都有值，不会缺点；e1RM 会因为
 * 「整场次数都 > 10」而在那条线上留空，列表行上出现一段空白会让人以为数据坏了。
 *
 * @param trained 练过的动作，仓储层已按最近训练时间倒序 —— 这一屏的排序就是它的
 *   排序，这里不重排
 * @param points 全部已完成的组（跨动作、跨场次），在这里按 exerciseId 就地分桶，
 *   每个桶一副表，交给 `buildProgressPoints` 变成按时间排好的进度点
 * @returns 一个动作一行；某个动作算不出任何进度点时整行丢掉 —— 画一条没有
 *   数据的走势比少一行更糟
 */
function buildRows(
  trained: TrainedExercise[],
  points: CompletedSetPoint[],
): ProgressRow[] {
  const byExercise = new Map<string, CompletedSetPoint[]>();
  for (const point of points) {
    const bucket = byExercise.get(point.exerciseId);
    if (bucket) bucket.push(point);
    else byExercise.set(point.exerciseId, [point]);
  }

  const rows: ProgressRow[] = [];
  for (const exercise of trained) {
    const series = buildProgressPoints(byExercise.get(exercise.exerciseId) ?? []);
    if (series.length === 0) continue;
    const last = series[series.length - 1];
    rows.push({
      exerciseId: exercise.exerciseId,
      name: exercise.name,
      lastTrainedAt: exercise.lastTrainedAt,
      lastTop: last.maxWeightSet,
      spark: toSeries(series, 'maxWeight'),
    });
  }
  return rows;
}

/**
 * 进步页首屏：练过的动作一行一个，右边挂一条迷你走势。
 *
 * 点一行进该动作的三张详情卡（`app/exercise/[id].tsx`）。这一屏只回答
 * 「哪个动作在涨」这一个问题，所以每行只放最近一次的重量和一条走势，
 * 不铺开别的数字。
 *
 * @returns 动作列表；没练过任何动作时是引导文案，取数失败时是错误文案
 */
export default function ProgressTab() {
  const exec = useDatabase();
  const router = useRouter();
  // 状态栏与标签栏的让位由 `Screen` 统一处理
  const styles = useProgressStyles();
  const palette = usePalette();

  // 列表数据源；取数失败时故意保留旧行，不清空
  const [rows, setRows] = useState<ProgressRow[]>([]);
  // 每次刷新都置真，但只有空列表时才画大转圈
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 异步取数的兜底开关：`load` 每个 await 之后都要问它一句「还挂着吗」
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * 取一份「动作 + 全部原始组」，再在内存里拼成列表行。
   *
   * 两个查询用 `Promise.all` 并发而不是串行：它们互不依赖，串起来只是白等一个
   * 往返的时间。
   *
   * 出错时只写 `error`，不抹掉已有的 `rows`。
   *
   * @returns 无返回值；结果落在 `rows` / `error` / `loading` 上
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [trained, points] = await Promise.all([
        listTrainedExercises(exec),
        listCompletedSetPoints(exec),
      ]);
      if (!mountedRef.current) return;
      setRows(buildRows(trained, points));
      setError(null);
    } catch (e) {
      // 取数失败不能白屏：亮出错误文案即可
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [exec]);

  // 每次进入这个标签页都重新取数。练完一场保存后切过来，只有 useFocusEffect
  // 能保证拿到刚写进去的那几组 —— useEffect 在标签页始终挂载的情况下不会再跑。
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /**
   * 画一行：左边动作名 + 「最近练的日期 · 那一场最重的一组」，右边一条迷你走势。
   *
   * @param item `buildRows` 拼出来的一行，`spark` 已经是画图直接可用的序列
   *   （可能含 null 表示那次训练没有可用的点）
   * @returns 可点击的一行；点进去是该动作的进步详情
   */
  const renderItem = useCallback(
    ({ item }: { item: ProgressRow }) => (
      <Pressable
        style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
        onPress={() => {
          // 必须用对象形式：typedRoutes 只生成 `/exercise/[id]` 这个字面量，
          // 模板字符串过不了 tsc。
          router.push({
            pathname: '/exercise/[id]',
            params: { id: item.exerciseId },
          });
        }}
      >
        <View style={styles.rowText}>
          <Text variant="title" numberOfLines={1}>
            {item.name}
          </Text>
          <View style={styles.rowMetaLine}>
            {/* 最近一次最重的一组：这一屏要回答的就是「这个动作在涨吗」，
                所以重量用等宽大字，日期退成旁边的说明 */}
            <Text variant="numeric" style={styles.rowMeta}>
              {item.lastTop.weight} kg
            </Text>
            <Text variant="caption" color="textMuted">
              × {item.lastTop.reps} · {formatDate(item.lastTrainedAt)}
            </Text>
          </View>
        </View>
        <View style={styles.spark}>
          <TrendChart values={item.spark} height={32} />
        </View>
      </Pressable>
    ),
    [router, styles],
  );

  /**
   * 列表为空时显示什么。和 `app/(tabs)/history.tsx` 是同一种三态写法：
   * 加载中不返回内容（上面已经画了转圈），报错说报错，否则给「去练第一次」的引导。
   *
   * @returns 空态占位元素；加载中时返回 null
   */
  const renderEmpty = () => {
    if (loading) return null;
    if (error) {
      return (
        <View style={styles.stateBox}>
          <Text variant="title" style={styles.errorTitle}>
            进步数据加载失败
          </Text>
          <Text variant="caption" color="textMuted" style={{ textAlign: 'center' }}>
            {error}
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.stateBox}>
        <Text variant="title">还没有训练记录</Text>
        <Text variant="caption" color="textMuted">
          去『训练』标签开始第一次吧
        </Text>
      </View>
    );
  };

  return (
    <Screen>
      <Text variant="h1" style={{ paddingTop: space.xl, paddingBottom: space.md }}>
        进步
      </Text>

      {loading && rows.length === 0 ? (
        <View style={styles.stateBox}>
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : null}

      <FlatList
        style={{ flex: 1 }}
        data={rows}
        keyExtractor={(item) => item.exerciseId}
        renderItem={renderItem}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={{ paddingBottom: space.lg }}
        ListEmptyComponent={renderEmpty()}
      />
    </Screen>
  );
}

/**
 * 行与行之间那条发丝细的分隔线。走势图本身没有边框，没有它两行会粘在一起。
 *
 * @returns 一条分隔线
 */
function Separator() {
  const palette = usePalette();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: palette.border,
      }}
    />
  );
}

/**
 * 这一屏用到的样式。
 *
 * 写成 hook 而不是模块级常量：颜色来自主题，模块级常量在模块加载时就固化了。
 *
 * @returns 绑定了当前主题的样式对象
 */
function useProgressStyles() {
  const palette = usePalette();

  return useMemo(
    () => ({
      row: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: space.md,
        paddingVertical: space.md,
      },
      rowText: { flex: 1, gap: space.xs },
      rowMetaLine: {
        flexDirection: 'row' as const,
        alignItems: 'baseline' as const,
        gap: space.sm,
      },
      rowMeta: { color: palette.text },
      // 迷你走势要有确定宽度，TrendChart 靠 onLayout 量它
      spark: { width: 72 },

      stateBox: {
        paddingVertical: space.huge,
        gap: space.sm,
        alignItems: 'center' as const,
      },
      errorTitle: { color: palette.danger },
    }),
    [palette],
  );
}
