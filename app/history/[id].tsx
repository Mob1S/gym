import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';

import { SessionSummaryView } from '../../src/components/SessionSummaryView';
import type { WorkoutSession } from '../../src/domain/types';
import { deleteSessionConfirmText } from '../../src/lib/deleteConfirm';
import { formatDate } from '../../src/lib/format';
import { isWebPreview } from '../../src/lib/preview';
import { useDatabase } from '../../src/repositories/database';
import {
  deleteSession,
  getSession,
  listSessionExercises,
} from '../../src/repositories/sessionRepo';
import { listSets } from '../../src/repositories/setRepo';
import { useActiveSession } from '../../src/store/activeSession';
import { Button, Screen, Text, space } from '../../src/ui';

/**
 * 历史详情页：翻看过去某一次训练的每一组与组间休息回顾。
 *
 * 内容全部来自 `SessionSummaryView`（和训练总结页共用同一套渲染），这一屏只
 * 负责三件它不管的事：滚动容器、顶部的训练名 + 日期、底部的「删除这条记录」。
 *
 * 这里**没有**「保存这次训练」按钮 —— 能走到这一页的训练都已经结束了，
 * 没有东西要保存；结束与保存只属于训练总结页。删除是另一回事：历史记录是
 * 可以不要的，入口只在这一页和 `app/(tabs)/history.tsx` 的列表行上。
 *
 * 安全区由 `app/_layout.tsx` 里给这个路由配的原生导航栏负责（`title: '训练详情'`），
 * 所以这一页不引入 `useSafeAreaInsets` —— 两套做法只能选一套，否则会双重留白。
 *
 * @returns 训练名 + 日期两行，接 `SessionSummaryView` 渲染的每一组与休息回顾，
 *   底部是删除入口（只在真取到这一场、且不在网页预览时渲染）
 */
export default function HistoryDetailScreen() {
  const exec = useDatabase();
  const router = useRouter();
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

  /**
   * 数这一场训练一共完成了多少组，喂给确认框里那句「和它的 N 组会一起消失」。
   *
   * 列表页的数字直接从摘要行读（`SessionSummary` 的 `setCount`），这一页没有
   * 摘要行，只能自己数一遍。**判定条件与仓储层 SQL 里那个「组数」逐字一致**：
   * 只算 `isCompleted` 的组，记录界面预建的占位组不算 —— 所以这里数出来的数字
   * 和屏幕上「总组数」那一格、以及历史列表行上的「N 组」是同一个数。
   *
   * N+1 条查询，所以只在按下「删除」时数，不在进页面时数：翻数据是常事，
   * 删记录不是。
   *
   * @param sessionId 要数的那一场训练
   * @returns 已完成的组数；一组都没完成时是 0
   */
  const countCompletedSets = async (sessionId: string): Promise<number> => {
    const exercises = await listSessionExercises(exec, sessionId);
    let total = 0;
    for (const item of exercises) {
      const sets = await listSets(exec, item.id);
      total += sets.filter((set) => set.isCompleted).length;
    }
    return total;
  };

  /**
   * 删这一条记录：先弹确认框，确认后删库、必要时清掉内存里那条进行中的训练，
   * 然后回历史列表。
   *
   * 文案来自 `deleteSessionConfirmText`，与 `app/(tabs)/history.tsx` 那份
   * **是同一份实现** —— 用户在哪一页按的删除，看到的后果必须一样。
   *
   * 组数是按下时才去数的，所以先把这一场固定成 `target`：await 之后组件可能
   * 已经卸载、state 也已经不是按下时的那个值，回调和后续步骤都只认 `target`。
   *
   * @returns 无返回值。Alert 是异步的，真正的删除在确认按钮的回调里
   */
  const confirmDelete = () => {
    // 按钮只在有数据时渲染，这里再判一次是给 tsc 收窄类型
    const target = session;
    if (!target) return;

    void (async () => {
      try {
        const setCount = await countCompletedSets(target.id);
        const { title, message } = deleteSessionConfirmText(
          target.startedAt,
          setCount,
        );
        // 只有「取消 / 删除」两个按钮：Android 上一个 Alert 最多三个，
        // 两个也已经把选择说全了
        Alert.alert(title, message, [
          { text: '取消', style: 'cancel' },
          {
            text: '删除',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  await deleteSession(exec, target.id);
                  // 删的正好是进行中的那一场时，内存里那条也要清掉，否则首页
                  // 「继续训练」会指向一条已经不存在的记录，点进去是一屏空白。
                  // 清掉之后首页会自己去库里重新 resume —— `app/(tabs)/index.tsx`
                  // 里 `session` 变成 null 就会再触发一次。
                  if (useActiveSession.getState().session?.id === target.id) {
                    useActiveSession.getState().reset();
                  }
                  // 这一条已经不存在了，留在这屏只会看到一屏空白，回列表去
                  router.back();
                } catch (e) {
                  Alert.alert(
                    '没能删掉这条记录',
                    e instanceof Error ? e.message : String(e),
                  );
                }
              })();
            },
          },
        ]);
      } catch (e) {
        // 组数数不出来 = 确认文案里的数字给不出来，这时宁可不弹确认框
        Alert.alert(
          '没能删掉这条记录',
          e instanceof Error ? e.message : String(e),
        );
      }
    })();
  };

  return (
    <Screen edgeToEdgeTop={false} padded={false}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: space.md,
          paddingBottom: space.xxl,
          gap: space.lg,
        }}
      >
        {/* 数据没回来之前不渲染标题：否则会先闪一下「未命名训练」再被真名顶掉 */}
        {loaded ? (
          <View style={{ gap: space.xs }}>
            <Text variant="h2">{session?.name ?? '未命名训练'}</Text>
            {session ? (
              <Text variant="caption" color="textMuted">
                {formatDate(session.startedAt)}
              </Text>
            ) : null}
          </View>
        ) : null}

        <SessionSummaryView sessionId={id} />

        {/* 只有真取到这一场时才给删除入口：id 是空的、或这条记录已经被删掉时，
            「删除这条记录」按下去没有任何东西可删。
            用 `danger` 变体，与设置页「导入备份」同一档视觉语义 —— 会毁数据的
            操作在整 App 里长得一样。

            **网页预览里整个不渲染**：`demoExecutor` 会把 `deleteSession` 的
            `DELETE FROM session WHERE id = ?` 当成「清空整表」，点下去看着像
            没反应。理由与那张清单见 `src/lib/preview.ts`。 */}
        {session && !isWebPreview ? (
          <Button
            label="删除这条记录"
            variant="danger"
            onPress={confirmDelete}
            style={{ marginTop: space.sm }}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}
