import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import {
  CANCELED_MESSAGE,
  pickAndImportBackup,
  shareBackup,
} from '../../src/lib/backupFile';
import { useDatabase } from '../../src/repositories/database';
import type { ThemeMode } from '../../src/repositories/settingsRepo';
import { useActiveSession } from '../../src/store/activeSession';
import { useThemePreference } from '../../src/store/themePreference';
import { Button, Card, Screen, Text, space, usePalette } from '../../src/ui';

/** 哪一件正在跑。用它同时禁用两个按钮 —— 导出和导入都要独占整库，不能并发 */
type RunningTask = 'export' | 'import' | null;

/**
 * 主题三选一的按钮顺序与文案。
 *
 * 「跟随系统」排第一：它是默认值，也是被选中的那一个该在的位置。
 */
const THEME_MODE_LABELS: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: '跟随系统' },
  { mode: 'light', label: '浅色' },
  { mode: 'dark', label: '深色' },
];

/**
 * 设置页：训练计划的入口，备份的导出 / 导入，外加一段组间休息的参考区间。
 *
 * 这一页做的每件事都动整库（导出读全库、导入换全库），所以两个按钮共用一个
 * `running` 互斥，任何一刻只允许跑一件。「管理训练计划」只跳转，不写库，
 * 不参与这个互斥。
 *
 * 休息参考区间只是一段静态文案：本 App 不做任何基于它的自动计算，
 * 训练后的比较只看用户自己的次数变化。
 *
 * @returns 设置页
 */
export default function SettingsTab() {
  const exec = useDatabase();
  const router = useRouter();
  const [running, setRunning] = useState<RunningTask>(null);

  // 主题偏好：当前选中的模式 + 切换函数。读取与落盘都在 Provider 里
  const { mode, setMode } = useThemePreference();
  // 这一页也要主题色（选中态那个橙底按钮），用同一个 palette 才不会和别处不一致
  const palette = usePalette();

  /**
   * 导出并分享一份备份文件。
   *
   * 失败要弹窗：分享面板没弹出来用户是看得见的，但「为什么」只有这里知道 ——
   * 静默失败等于让他以为备份已经存好了。
   *
   * @returns 无返回值（Promise，供按钮直接调用）；无论成败都会在最后把
   *   `running` 清掉，否则按钮会一直禁用着
   */
  const handleExport = useCallback(async () => {
    // 按钮已经 disabled，这里再挡一道：`disabled` 要等一次重渲染才生效，
    // 手快连点两下时第二次点击可能赶在重渲染之前。
    if (running !== null) return;
    setRunning('export');
    try {
      await shareBackup(exec);
    } catch (error) {
      // 失败必须说出来：分享面板没弹、文件没写出去，用户都看得见，
      // 但「为什么」只有这里知道。静默失败等于让他以为备份已经存好了。
      Alert.alert(
        '导出备份失败',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setRunning(null);
    }
  }, [exec, running]);

  /**
   * 选一个备份文件并整库导入。
   *
   * 导入成功之后必须把内存里的 `activeSession` 也清掉：导入是整库替换，
   * 刚才那一场进行中的训练如果不在备份里，此刻已经被删了，
   * 「继续上次训练」就会指向一条不存在的记录。
   *
   * @returns 无返回值；三种结局各自有反馈 —— 成功弹窗、失败弹窗、
   *   用户主动取消什么都不弹
   */
  const handleImport = useCallback(async () => {
    if (running !== null) return;
    setRunning('import');
    try {
      const result = await pickAndImportBackup(exec);
      if (result.ok) {
        // 导入是整库替换：如果刚才有一场进行中的训练、而它不在备份里，
        // 它现在已经被删掉了。内存里那条记录必须一起清掉，否则「继续上次训练」
        // 会指向一条不存在的记录，点进去是一屏空白。清掉之后训练页会自己
        // 从库里重新 resume，备份里真带着进行中的训练也接得回来。
        useActiveSession.getState().reset();
        Alert.alert('导入完成', result.message);
      } else if (result.message !== CANCELED_MESSAGE) {
        // 用户主动取消（没选文件、确认框点了取消）不是错误，不弹任何东西。
        Alert.alert('导入失败', result.message);
      }
    } catch (error) {
      // `pickAndImportBackup` 的约定是「不抛异常」，但它内部要调三个原生模块，
      // 兜一道底总比留一个 unhandled rejection + 永远禁用的按钮强。
      Alert.alert(
        '导入失败',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setRunning(null);
    }
  }, [exec, running]);

  // 用同一个布尔值同时禁用两个按钮：导出和导入都要独占整库，不能并发
  const busy = running !== null;

  return (
    <Screen padded={false}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: space.xl,
          paddingBottom: space.lg,
          gap: space.lg,
        }}
      >
        <Text variant="h1">设置</Text>

        <Card style={{ gap: space.sm }}>
          <Text variant="title">外观</Text>
          <Text variant="caption" color="textMuted">
            默认跟随系统的深色 / 浅色设置。也可以固定成其中一种，不随系统变。
          </Text>

          {/* 三选一而不是开关：开关只能表达「深/浅」两种，「跟随系统」没有位置放。
              它才是默认值，也是大多数人想要的 */}
          <View style={styles.modeRow}>
            {THEME_MODE_LABELS.map((item) => {
              const active = item.mode === mode;
              return (
                <Pressable
                  key={item.mode}
                  onPress={() => setMode(item.mode)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`主题：${item.label}`}
                  style={[
                    styles.modeButton,
                    {
                      backgroundColor: active
                        ? palette.accent
                        : palette.surfaceRaised,
                      borderColor: active ? palette.accent : palette.border,
                    },
                  ]}
                >
                  <Text
                    variant="caption"
                    style={{
                      fontWeight: '600',
                      color: active ? palette.onAccent : palette.textMuted,
                    }}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <Card style={{ gap: space.sm }}>
          <Text variant="title">训练计划</Text>
          <Text variant="caption" color="textMuted">
            编排你的分化循环（推日 / 拉日 / 腿日……），开始训练时会按顺序自动轮转。
          </Text>
          <Button
            label="管理训练计划"
            variant="secondary"
            onPress={() => router.push('/plan')}
            style={{ marginTop: space.sm }}
          />
        </Card>

        <Card style={{ gap: space.sm }}>
          <Text variant="title">备份</Text>
          <Text variant="caption" color="textMuted">
            训练记录只存在这台手机上。App 卸载、手机丢失或系统清理数据都会让记录一起消失，
            建议定期导出一份存到别处。
          </Text>

          <Button
            label="导出备份"
            onPress={() => {
              void handleExport();
            }}
            loading={running === 'export'}
            loadingLabel="导出中…"
            disabled={busy}
            style={{ marginTop: space.sm }}
          />

          {/* 导入是整库替换，会把当前记录全部覆盖 —— 用警示色，别让它看起来
              和「导出」一样安全 */}
          <Button
            label="导入备份"
            variant="danger"
            onPress={() => {
              void handleImport();
            }}
            loading={running === 'import'}
            loadingLabel="导入中…"
            disabled={busy}
          />

          <Text variant="caption" color="textFaint" style={{ marginTop: space.sm }}>
            导入会用自己的备份整体替换当前记录（不是合并），替换后无法撤销。
          </Text>
        </Card>

        <Card style={{ gap: space.sm }}>
          <Text variant="title">组间休息的一般参考</Text>
          {/* 两条区间用等宽数字，和 App 里其他数字同一套读法 */}
          <View style={styles.referenceLine}>
            <Text variant="numeric" style={styles.referenceValue}>
              2 – 3 分钟
            </Text>
            <Text variant="caption" color="textMuted" style={{ flexShrink: 1 }}>
              多关节动作（深蹲、卧推、硬拉等）
            </Text>
          </View>
          <View style={styles.referenceLine}>
            <Text variant="numeric" style={styles.referenceValue}>
              1 – 2 分钟
            </Text>
            <Text variant="caption" color="textMuted" style={{ flexShrink: 1 }}>
              单关节动作（弯举、侧平举等）
            </Text>
          </View>
          <Text variant="caption" color="textFaint" style={{ marginTop: space.sm }}>
            以上是 ACSM 立场声明给出的一般区间，仅供参考。
            本 App 不会用它做任何自动计算 —— 训练后只比较你自己这次的次数变化。
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // 三选一横排。等宽（flex: 1）比按文字宽度自适应更整齐，
  // 而且选中态换到哪一项都不会让整排宽度跳一下
  modeRow: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  modeButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: space.md,
    borderRadius: 12,
    borderWidth: 1,
  },

  referenceLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.md,
  },
  referenceValue: { fontSize: 15 },
});
