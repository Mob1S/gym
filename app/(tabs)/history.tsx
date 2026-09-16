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

import { useDatabase } from '../../src/repositories/database';
import {
  listSessionSummaries,
  type SessionSummary,
} from '../../src/repositories/sessionRepo';

/** 列表一次取多少条：够翻一阵子，又不至于把几十场训练全塞进内存 */
const HISTORY_LIMIT = 50;

/** 下标即 `getDay()` 的返回值：0 = 周日，1 = 周一 …… 6 = 周六 */
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** `9月16日 周三` —— 用本地时区的 getter，绕开 toLocaleDateString 在 Hermes 上的地区差异 */
function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${
    WEEKDAY_LABELS[date.getDay()]
  }`;
}

/** 容量是「重量 × 次数」累加出来的大数，加千位分隔才读得下去 */
function formatVolume(volumeKg: number): string {
  return Math.round(volumeKg).toLocaleString('en-US');
}

function formatDuration(minutes: number): string {
  return `${Math.round(minutes)} 分钟`;
}

export default function HistoryTab() {
  const exec = useDatabase();
  const router = useRouter();

  // 这个标签页的 Tabs 布局设了 headerShown: false，没有导航栏帮忙让出状态栏，
  // 所以顶部要自己用 insets 压下来。底部虽然由 tab bar 占位，仍额外留一点
  // 呼吸空间，免得最后一行紧贴 tab bar。
  const insets = useSafeAreaInsets();

  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
