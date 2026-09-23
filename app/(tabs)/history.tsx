import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatDate } from '../../src/lib/format';
import { useDatabase } from '../../src/repositories/database';
import {
  listSessionSummaries,
  type SessionSummary,
} from '../../src/repositories/sessionRepo';

/** 列表一次取多少条：够翻一阵子，又不至于把几十场训练全塞进内存 */
const HISTORY_LIMIT = 50;

/**
 * 容量是「重量 × 次数」累加出来的大数，加千位分隔才读得下去
 *
 * @param volumeKg 整场的训练容量（kg），由每一组的 重量 × 次数 累加而来，
 *   是浮点数；只算已完成的组
 * @returns 四舍五入到整数并带千位分隔的字符串（`12,340`）—— `12340` 和
 *   `1234` 在小字里长得太像，分隔符是唯一能一眼分清的东西
 */
function formatVolume(volumeKg: number): string {
  return Math.round(volumeKg).toLocaleString('en-US');
}

/**
 * 整场时长。取整成分钟：列表里那行小字塞不下「47.3 分钟」，也没人关心
 * 那 18 秒。
 *
 * @param minutes 时长（分钟），由 startedAt 与 finishedAt 相减得到
 * @returns 形如 `47 分钟`
 */
function formatDuration(minutes: number): string {
  return `${Math.round(minutes)} 分钟`;
}

/**
 * 历史列表页：按时间倒序列出练过的每一场。
 *
 * 一行只给三件事 —— 日期、训练名、时长 / 组数 / 容量，细节都在点进去之后的
 * `app/history/[id].tsx`。这一页自己不做任何聚合，`listSessionSummaries`
 * 在 SQL 里就算好了。
 *
 * @returns 历史列表；库里没有记录时是引导文案，取数失败时是错误文案加原始信息
 */
export default function HistoryTab() {
  const exec = useDatabase();
  const router = useRouter();

  // 这个标签页的 Tabs 布局设了 headerShown: false，没有导航栏帮忙让出状态栏，
  // 所以顶部要自己用 insets 压下来。底部虽然由 tab bar 占位，仍额外留一点
  // 呼吸空间，免得最后一行紧贴 tab bar。
  const insets = useSafeAreaInsets();

  // 列表数据源。取数失败时**故意**不清空它，见下面 `load` 的注释
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  // 每次刷新都会置真，但只有一个空列表时才画大转圈：已有内容时刷新不该闪屏
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 异步取数的兜底开关：`load` 每个 await 之后都要问它一句「还挂着吗」，
  // 否则用户切走后才 resolve 的那次 setState 会落在已卸载的组件上
  const mountedRef = useRef(true);

  // 挂载时置真、卸载时置假 —— 它要跨整个页面生命周期有效，不能用 state
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * 取一页训练摘要。可以重复调用（每次进标签页都会再跑一次）。
   *
   * 出错时只写 `error`、**不动 `summaries`**：把手里已有的列表抹成白屏，
   * 比留着上一次的数据外加一行错误提示糟得多。
   *
   * @returns 无返回值；结果落在 `summaries` / `error` / `loading` 三个 state 上
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listSessionSummaries(exec, HISTORY_LIMIT);
      if (!mountedRef.current) return;
      setSummaries(rows);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      // 取数失败不能白屏，也不能把已有列表抹掉：亮出错误文案即可。
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [exec]);

  // 每次进入这个标签页都重新取数。练完保存回到「训练」标签后切过来，
  // 只有 useFocusEffect 能保证拿到刚写入的那条记录 —— useEffect 在
  // 标签页始终挂载的情况下不会再跑第二次。
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /**
   * 画一行。三个字段全部来自仓储层，界面不再二次计算 —— 日期用
   * `formatDate`（与详情页那份保持同一种写法），训练名限制一行，
   * 超长就截断而不是撑破行高。
   *
   * @param item `listSessionSummaries` 返回的一行（已按时间倒序）
   * @returns 可点击的一行；点进去是该场的详情页
   */
  const renderItem = useCallback(
    ({ item }: { item: SessionSummary }) => (
      <Pressable
        style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
        onPress={() => {
          // 必须用对象形式。typedRoutes 对动态路由生成的是 `/history/[id]`
          // 这个字面量，模板字符串过不了 tsc。
          router.push({ pathname: '/history/[id]', params: { id: item.id } });
        }}
      >
        <Text style={styles.rowDate}>{formatDate(item.startedAt)}</Text>
        <Text style={styles.rowName} numberOfLines={1}>
          {item.name ?? '未命名训练'}
        </Text>
        <Text style={styles.rowMeta}>
          {formatDuration(item.durationMinutes)} · {item.setCount} 组 ·{' '}
          {formatVolume(item.volumeKg)} kg
        </Text>
      </Pressable>
    ),
    [router],
  );

  /**
   * 列表为空时显示什么。注意是**调用**它并把结果当 prop 传下去
   * （`ListEmptyComponent={renderEmpty()}`），所以这里返回的是元素而不是组件。
   *
   * 三种情况互斥：加载中什么都不返回（上面已经画了转圈），有错说错，
   * 否则才是「还没练过」的引导。
   *
   * @returns 空态占位元素；加载中时返回 null
   */
  const renderEmpty = () => {
    if (loading) return null;
    if (error) {
      return (
        <View style={styles.stateBox}>
          <Text style={styles.errorTitle}>历史记录加载失败</Text>
          <Text style={styles.stateHint}>{error}</Text>
        </View>
      );
    }
    return (
      <View style={styles.stateBox}>
        <Text style={styles.emptyTitle}>还没有训练记录</Text>
        <Text style={styles.stateHint}>去『训练』标签开始第一次吧</Text>
      </View>
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Text style={styles.title}>历史</Text>

      {loading && summaries.length === 0 ? (
        <View style={styles.stateBox}>
          <ActivityIndicator />
        </View>
      ) : null}

      <FlatList
        style={styles.list}
        data={summaries}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: insets.bottom + 24 },
        ]}
        ListEmptyComponent={renderEmpty()}
      />
    </View>
  );
}

/**
 * 行与行之间那条发丝细的分隔线。
 *
 * 因为发丝线的粗细依赖屏幕像素密度，只能由 StyleSheet 算出来再套一个 View ——
 * 分不出更省事的写法。
 *
 * @returns 一条分隔线
 */
function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  title: {
    fontSize: 24,
    fontWeight: '700',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },

  list: { flex: 1 },
  listContent: { paddingHorizontal: 20 },

  row: { paddingVertical: 14, gap: 4 },
  rowPressed: { opacity: 0.5 },
  rowDate: { fontSize: 13, color: '#8a8f98' },
  rowName: { fontSize: 17, fontWeight: '600' },
  rowMeta: { fontSize: 13, color: '#4b5058' },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: '#e3e5e9' },

  stateBox: { paddingVertical: 48, paddingHorizontal: 20, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  errorTitle: { fontSize: 16, fontWeight: '600', color: '#c0392b' },
  stateHint: { fontSize: 13, color: '#8a8f98' },
});
