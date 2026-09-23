import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  CANCELED_MESSAGE,
  pickAndImportBackup,
  shareBackup,
} from '../../src/lib/backupFile';
import { useDatabase } from '../../src/repositories/database';
import { useActiveSession } from '../../src/store/activeSession';

/** 哪一件正在跑。用它同时禁用两个按钮 —— 导出和导入都要独占整库，不能并发 */
type RunningTask = 'export' | 'import' | null;

/**
 * 设置页：备份的导出 / 导入，外加一段组间休息的参考区间。
 *
 * 这一页做的每件事都动整库（导出读全库、导入换全库），所以两个按钮共用一个
 * `running` 互斥，任何一刻只允许跑一件。
 *
 * 休息参考区间只是一段静态文案：本 App 不做任何基于它的自动计算，
 * 训练后的比较只看用户自己的次数变化。
 *
 * @returns 设置页
 */
export default function SettingsTab() {
  const exec = useDatabase();
  const [running, setRunning] = useState<RunningTask>(null);

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
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>设置</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>备份</Text>
        <Text style={styles.line}>
          训练记录只存在这台手机上。App 卸载、手机丢失或系统清理数据都会让记录一起消失，
          建议定期导出一份存到别处。
        </Text>

        <Pressable
          style={[styles.button, styles.exportButton, busy && styles.buttonDisabled]}
          onPress={handleExport}
          disabled={busy}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>
            {running === 'export' ? '导出中…' : '导出备份'}
          </Text>
        </Pressable>

        {/* 导入是整库替换，会把当前记录全部覆盖 —— 用警示色，别让它看起来
            和「导出」一样安全 */}
        <Pressable
          style={[styles.button, styles.importButton, busy && styles.buttonDisabled]}
          onPress={handleImport}
          disabled={busy}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>
            {running === 'import' ? '导入中…' : '导入备份'}
          </Text>
        </Pressable>

        <Text style={styles.note}>
          导入会用自己的备份整体替换当前记录（不是合并），替换后无法撤销。
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>组间休息的一般参考</Text>
        <Text style={styles.line}>· 多关节动作（深蹲、卧推、硬拉等）：2 – 3 分钟</Text>
        <Text style={styles.line}>· 单关节动作（弯举、侧平举等）：1 – 2 分钟</Text>
        <Text style={styles.note}>
          以上是 ACSM 立场声明给出的一般区间，仅供参考。
          本 App 不会用它做任何自动计算 —— 训练后只比较你自己这次的次数变化。
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 16 },
  title: { fontSize: 24, fontWeight: '700' },
  card: { backgroundColor: '#f4f5f7', borderRadius: 12, padding: 16, gap: 6 },
  cardTitle: { fontSize: 15, fontWeight: '700', marginBottom: 4 },
  line: { fontSize: 14, color: '#4b5058', lineHeight: 20 },
  note: { fontSize: 12, color: '#8a8f98', marginTop: 8, lineHeight: 18 },

  button: { borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 6 },
  exportButton: { backgroundColor: '#2b7fff' },
  importButton: { backgroundColor: '#e5484d' },
  // 进行中：变淡即可，文案本身会变成「导出中…／导入中…」
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
