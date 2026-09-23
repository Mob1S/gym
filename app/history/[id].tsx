import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { SessionSummaryView } from '../../src/components/SessionSummaryView';
import type { WorkoutSession } from '../../src/domain/types';
import { useDatabase } from '../../src/repositories/database';
import { getSession } from '../../src/repositories/sessionRepo';

/** 下标即 `getDay()` 的返回值：0 = 周日，1 = 周一 …… 6 = 周六 */
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * `9月16日 周三`。
 *
 * 和历史列表页 `app/(tabs)/history.tsx` 里的同名函数保持一致 —— 同一个日期在
 * 列表和详情里必须是同一种写法。只有这么几行，还没有第三个使用方，先不抽公共
 * 工具函数，免得为一个格式化多一层间接。
 *
 * @param timestamp 毫秒时间戳（`session.startedAt`）
 * @returns 形如 `9月16日 周三`。刻意不带年份：这一页看的是近期的训练，
 *   多一个年份只是噪音
 */
function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${
    WEEKDAY_LABELS[date.getDay()]
  }`;
}

/**
 * 历史详情页：翻看过去某一次训练的每一组与组间休息回顾。
 *
 * 内容全部来自 `SessionSummaryView`（和训练总结页共用同一套渲染），这一屏只
 * 负责两件它不管的事：滚动容器和顶部的训练名 + 日期。
 *
 * 这里**没有**「保存这次训练」按钮 —— 能走到这一页的训练都已经结束了，
 * 没有东西要保存；结束与保存只属于训练总结页。
 *
 * 安全区由 `app/_layout.tsx` 里给这个路由配的原生导航栏负责（`title: '训练详情'`），
 * 所以这一页不引入 `useSafeAreaInsets` —— 两套做法只能选一套，否则会双重留白。
 *
 * @returns 训练名 + 日期两行，下面接 `SessionSummaryView` 渲染的每一组与休息回顾
 */
export default function HistoryDetailScreen() {
  const exec = useDatabase();
  const { id } = useLocalSearchParams<{ id: string }>();

  // 只查训练本身，要的就是 `name` / `startedAt` 两个字段；组和休息回顾
  // 由下面的 SessionSummaryView 自己按 id 查
  const [session, setSession] = useState<WorkoutSession | null>(null);
  // 取过一次才置真。只判 `session === null` 不行 —— 一个查不到的 id 会和
  // 「还在查」长得一模一样，那就没有东西能把标题区区分开了
  const [loaded, setLoaded] = useState(false);

  // 按路由参数查这一场训练。`cancelled` 防的是快速返回再进另一场时，
  // 先发的请求后到、把上一场的名字盖上去
  useEffect(() => {
    if (!id) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      const current = await getSession(exec, id);
      if (cancelled) return;
      setSession(current);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [exec, id]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      {/* 数据没回来之前不渲染标题：否则会先闪一下「未命名训练」再被真名顶掉 */}
      {loaded ? (
        <View style={styles.header}>
          <Text style={styles.name}>{session?.name ?? '未命名训练'}</Text>
          {session ? (
            <Text style={styles.date}>{formatDate(session.startedAt)}</Text>
          ) : null}
        </View>
      ) : null}

      <SessionSummaryView sessionId={id} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  container: { padding: 20, paddingBottom: 32, gap: 14 },

  header: { gap: 4 },
  name: { fontSize: 22, fontWeight: '700' },
  date: { fontSize: 13, color: '#8a8f98' },
});
