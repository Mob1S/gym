import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionSummaryView } from '../../../src/components/SessionSummaryView';
import { releaseScreenAwake } from '../../../src/lib/keepAwake';
import { useDatabase } from '../../../src/repositories/database';
import { finishSession } from '../../../src/repositories/sessionRepo';
import { useActiveSession } from '../../../src/store/activeSession';

/**
 * 训练总结页：一次训练结束后，把统计数字和「组间休息回顾」摊开给用户看。
 *
 * 内容本身（统计 + 休息回顾）在 `SessionSummaryView` 里，和历史详情页共用；
 * 这一屏只多一个「保存这次训练」按钮，负责结束训练并回到标签页。
 */
export default function SummaryScreen() {
  const exec = useDatabase();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // 这个路由在 app/_layout.tsx 里设了 headerShown: false，没有导航栏帮忙让出
  // 状态栏，所以必须自己用 insets 把内容压下来。安全区归页面管：组件还要被
  // 历史详情页复用，那一页的外壳（导航栏 / 滚动容器）不一定和这里一样。
  const insets = useSafeAreaInsets();

  const endWorkout = useActiveSession((s) => s.endWorkout);
  const reset = useActiveSession((s) => s.reset);

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // endWorkout 会结束进行中的休息并写入 finished_at。它只作用于 store 里
      // 那场训练，所以补一道兜底：强杀后经深链直接进这一屏时 store 是空的，
      // 光靠它 finished_at 永远不会写，训练页会一直显示「继续上次训练」。
      await endWorkout(exec);
      if (id && useActiveSession.getState().session?.id !== id) {
        await finishSession(exec, id, Date.now());
      }

      // `endWorkout` 会把刚结束的这场训练留在 store 里（finishedAt 非空），
      // 而训练页只看 session 是否存在就显示「继续上次训练」—— 不 reset 的话，
      // 保存完回到训练页仍会看到那个按钮，点进去是一场已经结束的训练。
      reset();
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
        <Text style={styles.saveButtonText}>保存这次训练</Text>
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
