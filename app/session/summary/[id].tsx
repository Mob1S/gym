import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionSummaryView } from '../../../src/components/SessionSummaryView';
import { releaseScreenAwake } from '../../../src/lib/keepAwake';
import { useDatabase } from '../../../src/repositories/database';
import { finishSession, getSession } from '../../../src/repositories/sessionRepo';

/**
 * 训练总结页：一次训练结束后，把统计数字和「组间休息回顾」摊开给用户看。
 *
 * 内容本身（统计 + 休息回顾）在 `SessionSummaryView` 里，和历史详情页共用；
 * 这一屏只多一个「保存这次训练」按钮，负责结束训练并回到标签页。
 *
 * 路由参数 `id` 是 workout_session.id。它可能缺省（深链没带参数），这里不做
 * 判断直接透传给 `SessionSummaryView`，那一层会自己渲染空态。
 *
 * @returns 统计 + 休息回顾，底部一个「完成」按钮
 */
export default function SummaryScreen() {
  const exec = useDatabase();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // 这个路由在 app/_layout.tsx 里设了 headerShown: false，没有导航栏帮忙让出
  // 状态栏，所以必须自己用 insets 把内容压下来。安全区归页面管：组件还要被
  // 历史详情页复用，那一页的外壳（导航栏 / 滚动容器）不一定和这里一样。
  const insets = useSafeAreaInsets();

  // 提交中：把按钮置为禁用。`handleSave` 开头还有一道同步判断，挡的是
  // disabled 生效之前的那第二下点击
  const [saving, setSaving] = useState(false);

  /**
   * 「完成」：补上可能漏写的结束时间，放掉屏幕常亮，回标签页。
   *
   * 不结束训练、不删记录 —— 这一步只是收尾，记录早在用户点「结束训练」时
   * 就落盘了。
   *
   * @returns 无返回值；失败时弹窗说明原因并留在这一屏（按钮重新可点），
   *   成功才真正离开
   */
  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // 落盘已经在「结束训练」那一下完成了，这里只做兜底：强杀后经深链直接进
      // 这一屏时 store 是空的，那一下没跑过，这一场的 finished_at 还是 NULL。
      //
      // **只在这场确实没结束时才写。** 无条件覆盖会把已经写好的结束时间往后推，
      // 总结页的时长跟着一起变长 —— 那是用户能看见的数字。
      if (id) {
        const stored = await getSession(exec, id);
        if (stored && stored.finishedAt === null) {
          await finishSession(exec, id, Date.now());
        }
      }

      releaseScreenAwake();
      router.replace('/(tabs)');
    } catch (e) {
      // 保存失败必须让用户知道，否则他会以为这次训练已经存好了。
      Alert.alert('没能保存这次训练', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

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
      <SessionSummaryView sessionId={id} />

      <Pressable
        style={[styles.saveButton, saving ? styles.saveButtonDisabled : null]}
        onPress={() => {
          void handleSave();
        }}
        disabled={saving}
      >
        <Text style={styles.saveButtonText}>完成</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  container: { padding: 20, gap: 14 },

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
