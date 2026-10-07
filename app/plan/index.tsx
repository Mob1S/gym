import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  TextInput,
  View,
} from 'react-native';

import { useDatabase } from '../../src/repositories/database';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  moveTemplate,
  renameTemplate,
  setTemplateExercises,
  type TemplateSummary,
} from '../../src/repositories/templateRepo';
import {
  Button,
  Screen,
  Text,
  border,
  fontSize,
  radius,
  space,
  usePalette,
  weight,
} from '../../src/ui';

/** 复制出来的计划名后缀。分化计划里「在腿日基础上改出腿日 B」是常见需求 */
const COPY_SUFFIX = ' 副本';

/**
 * 底部弹层的两种形态。
 *
 * **为什么是弹层不是 `Alert`：** Android 上一个 Alert 最多三个按钮，第四个会被
 * 静默丢掉，而这里要四件事 —— 重命名、复制、删除、取消。
 * `null` 表示弹层关着。
 */
type SheetMode = 'menu' | 'rename';

/**
 * 计划列表页：编排分化循环（推日 / 拉日 / 腿日……）。
 *
 * 顺序就是轮转顺序，所以每行右侧常驻「↑」「↓」两个按钮 —— 不用长按、不用进
 * 编辑页就能重排。第一行的「↑」与最后一行的「↓」保留在屏幕上但置灰：按钮位置
 * 跳动比一个灰按钮更让人困惑。
 *
 * 每行的「⋯」打开底部弹层而不是 `Alert`，原因见 `SheetMode` 的注释。
 *
 * @returns 计划列表；一个计划都没有时是引导新建的空态，取数失败时是错误文案
 */
export default function PlanListScreen() {
  const exec = useDatabase();
  const router = useRouter();

  // 绑定了当前主题的样式。必须在这一屏的顶层调用一次，下面几个早返回分支共用它
  const styles = usePlanListStyles();
  // 弹层里输入框的占位文字色也要跟主题走
  const palette = usePalette();

  // 列表数据源。取数失败时**故意**不清空它：把手里已有的列表抹成白屏，
  // 比留着上一次的数据外加一行错误提示糟得多
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  // 每次刷新都会置真，但只有一个空列表时才画大转圈：已有内容时刷新不该闪屏
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 弹层开着时是它对应的那个计划；null 即关闭
  const [sheetTarget, setSheetTarget] = useState<TemplateSummary | null>(null);
  const [sheetMode, setSheetMode] = useState<SheetMode>('menu');
  // 重命名输入框里的原始文字，点「保存」时才 trim
  const [renameText, setRenameText] = useState('');
  // 复制/删除/重命名进行中：按钮禁用，避免连点两次建出两份副本
  const [busy, setBusy] = useState(false);

  // 异步回写的兜底开关：每个 await 之后都要问它一句「还挂着吗」，
  // 否则用户切走后才 resolve 的那次 setState 会落在已卸载的组件上
  const mountedRef = useRef(true);
  // 同步的忙碌标记。`busy` 要等一次重渲染才生效，挡不住连点
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * 重新取一遍全部计划。可以重复调用（每次进入、每次移动、每次增删之后）。
   *
   * 出错时只写 `error`、**不动 `templates`**，理由见 `templates` 的注释。
   *
   * @returns 无返回值；结果落在 `templates` / `error` / `loading` 三个 state 上
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listTemplates(exec);
      if (!mountedRef.current) return;
      setTemplates(rows);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [exec]);

  // 每次进入都重新取数。从编辑页返回后必须看到新的动作数和顺序 ——
  // useEffect 在页面常驻于返回栈上时不会再跑第二次
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /**
   * 打开某一行的底部弹层，并顺手把重命名输入框填成当前名字。
   *
   * @param template 用户点了「⋯」的那一行
   * @returns 无返回值
   */
  const openSheet = (template: TemplateSummary) => {
    setSheetTarget(template);
    setSheetMode('menu');
    setRenameText(template.name);
  };

  /**
   * 关掉弹层。点背景、点「取消」、按 Android 返回键、任何一项执行完，
   * 四条路都汇到这里。
   *
   * @returns 无返回值
   */
  const closeSheet = () => {
    setSheetTarget(null);
    setSheetMode('menu');
  };

  /**
   * 把某一行往上或往下挪一格。
   *
   * **不先做本地的乐观更新**：`moveTemplate` 收的是位置号，本地挪一下再异步写库，
   * 用户在写入落盘前连点两下就会算出错误的目标位置。写完重取一次，
   * 屏幕上的顺序永远等于库里的顺序。
   *
   * @param position 这一行当前的位置号，就是 `item.position`
   * @param offset -1 上移，+1 下移
   * @returns 无返回值
   */
  const moveBy = async (position: number, offset: number) => {
    const target = position + offset;
    if (target < 0 || target >= templates.length) return;
    try {
      await moveTemplate(exec, position, target);
      await load();
    } catch (e) {
      Alert.alert('没能调整顺序', e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * 复制一整套计划：读原计划的动作清单 → 建一个「X 副本」→ 把动作整体写进去。
   *
   * 三步全部由现成接口拼出来，**没有新接口** —— 这是「动作清单只有整体覆盖
   * 一个写入口」这个设计的直接收益：复制与编辑用的是同一套写入路径。
   *
   * 顺序不能反：必须先把副本建出来拿到 id，才谈得上往里写动作。
   *
   * @param template 被复制的那一套
   * @returns 无返回值；成功与否都以 `Alert` 收尾（失败必须说出来，
   *   否则用户会以为副本已经建好了）
   */
  const duplicateTemplate = async (template: TemplateSummary) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const detail = await getTemplate(exec, template.id);
      if (!detail) throw new Error(`计划「${template.name}」已经不存在了`);
      const created = await createTemplate(exec, template.name + COPY_SUFFIX);
      await setTemplateExercises(
        exec,
        created.id,
        detail.exercises.map((item) => item.templateExercise.exerciseId),
      );
      await load();
      closeSheet();
      Alert.alert(
        `已复制「${created.name}」`,
        `动作清单和「${template.name}」一样，点进去就能改。`,
      );
    } catch (e) {
      Alert.alert('没能复制这套计划', e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  /**
   * 删除一个计划。
   *
   * 确认文案必须说清**历史不受影响**：用户真正怕的不是少一套计划，
   * 而是「用它练过的十几场记录会不会一起没了」。`N` 由 `deleteTemplate`
   * 的返回值给出，是这一句里唯一有信息量的数字。
   *
   * 删除用 `Alert` 做二次确认是够的 —— 只有「删除」「取消」两个按钮，
   * 没碰到 Android 三个按钮的上限。
   *
   * @param template 被删的那一套
   * @returns 无返回值；真正的删除在确认按钮的回调里
   */
  const confirmDelete = (template: TemplateSummary) => {
    Alert.alert('删除计划', `正在删除「${template.name}」…`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            if (busyRef.current) return;
            busyRef.current = true;
            setBusy(true);
            try {
              const { affectedSessions } = await deleteTemplate(exec, template.id);
              await load();
              closeSheet();
              // 这里不弹「已删除」：列表上那一行消失了，本身就是最清楚的反馈；
              // 只有确实牵连到历史记录时才值得再说一句
              if (affectedSessions > 0) {
                Alert.alert(
                  '已删除',
                  `用它练过的 ${affectedSessions} 场训练都还在，只是不再属于这个计划。`,
                );
              }
            } catch (e) {
              Alert.alert(
                '没能删除这个计划',
                e instanceof Error ? e.message : String(e),
              );
            } finally {
              busyRef.current = false;
              if (mountedRef.current) setBusy(false);
            }
          })();
        },
      },
    ]);
  };

  /**
   * 把重命名输入框里的文字落库。
   *
   * 名字为空时直接不保存并关掉弹层：`renameTemplate` 允许空串，但一个没有名字的
   * 计划在列表上会变成一行空白，比「什么都没发生」糟得多。
   *
   * @param template 被改名的计划
   * @returns 无返回值
   */
  const submitRename = async (template: TemplateSummary) => {
    const name = renameText.trim();
    if (!name) {
      closeSheet();
      return;
    }
    try {
      await renameTemplate(exec, template.id, name);
      await load();
      closeSheet();
    } catch (e) {
      Alert.alert('没能改名', e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * 进入编辑页。**必须用对象形式**：typedRoutes 只生成 `/plan/[id]` 这个字面量，
   * 模板字符串过不了 tsc。
   *
   * @param id 计划 id；`'new'` 表示新建
   * @returns 无返回值
   */
  const openEditor = (id: string) => {
    router.push({ pathname: '/plan/[id]', params: { id } });
  };

  /**
   * 画一行：计划名 + 动作数 + 三个行内按钮。
   *
   * 上移/下移**保留但置灰**（`disabled`）而不是消失：这两个按钮在每一行的同一个
   * 位置上，少了任何一个都会让整列按钮跳一下，而健身房里的手指本来就点不准。
   *
   * @param item `listTemplates` 返回的一行（已按轮转顺序）
   * @param index 它在列表里的下标，只用来判断「是不是第一行 / 最后一行」
   * @returns 可点击的一行：点名字进编辑页，「↑」「↓」「⋯」各自处理
   */
  const renderRow = ({ item, index }: { item: TemplateSummary; index: number }) => {
    const isFirst = index === 0;
    const isLast = index === templates.length - 1;
    return (
      <Pressable
        style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
        onPress={() => openEditor(item.id)}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}，${item.exerciseCount} 个动作`}
      >
        <View style={styles.rowText}>
          <Text variant="title" numberOfLines={1}>
            {item.name}
          </Text>
          <Text variant="caption" color="textMuted">
            {item.exerciseCount} 个动作
          </Text>
        </View>

        <View style={styles.rowActions}>
          <Pressable
            onPress={() => {
              void moveBy(item.position, -1);
            }}
            disabled={isFirst}
            style={({ pressed }) => [
              styles.iconButton,
              {
                borderColor: palette.border,
                backgroundColor: palette.surfaceRaised,
                opacity: isFirst ? 0.35 : pressed ? 0.5 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`上移「${item.name}」`}
            accessibilityState={{ disabled: isFirst }}
          >
            <Text variant="body" style={styles.iconButtonText}>
              ↑
            </Text>
          </Pressable>

          <Pressable
            onPress={() => {
              void moveBy(item.position, 1);
            }}
            disabled={isLast}
            style={({ pressed }) => [
              styles.iconButton,
              {
                borderColor: palette.border,
                backgroundColor: palette.surfaceRaised,
                opacity: isLast ? 0.35 : pressed ? 0.5 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`下移「${item.name}」`}
            accessibilityState={{ disabled: isLast }}
          >
            <Text variant="body" style={styles.iconButtonText}>
              ↓
            </Text>
          </Pressable>

          <Pressable
            onPress={() => openSheet(item)}
            style={({ pressed }) => [
              styles.iconButton,
              {
                borderColor: palette.border,
                backgroundColor: palette.surfaceRaised,
                opacity: pressed ? 0.5 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`「${item.name}」的更多操作`}
          >
            <Text variant="body" style={styles.iconButtonText}>
              ⋯
            </Text>
          </Pressable>
        </View>
      </Pressable>
    );
  };

  // 列表为空时显示什么。三种情况互斥：加载中什么都不画（上面已经画了转圈），
  // 有错说错，否则才是引导新建
  const renderEmpty = () => {
    if (loading) return null;
    if (error) {
      return (
        <View style={styles.stateBox}>
          <Text variant="title" style={styles.errorTitle}>
            计划加载失败
          </Text>
          <Text variant="caption" color="textMuted" style={styles.stateHint}>
            {error}
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.stateBox}>
        <Text variant="title">还没有训练计划</Text>
        <Text variant="caption" color="textMuted" style={styles.stateHint}>
          不建也能用，新训练会沿用上一次的动作。
        </Text>
        <Text variant="caption" color="textMuted" style={styles.stateHint}>
          建好之后，每次开始训练就不必再手动挑一遍动作了。
        </Text>
        <Button
          label="＋　新建计划"
          onPress={() => openEditor('new')}
          accessibilityLabel="新建计划"
          style={{ marginTop: space.md }}
        />
      </View>
    );
  };

  // 弹层：关着时是 null；开着时是「菜单」或「重命名输入」两种形态之一。
  //
  // 结构照 `app/session/[id].tsx` 的 pickerModal：背景 Pressable 关掉 + 底部 sheet。
  // 内容随形态切换，而不是叠两个 Modal —— 用户点「重命名」时看到的是同一张 sheet
  // 就地变成输入框，没有「又开了一层」的错觉。
  const sheet = !sheetTarget ? null : (
    <Modal
      visible
      transparent
      animationType="slide"
      // Android 的物理返回键 / 手势返回：不接这个回调，返回键会直接退出整屏
      onRequestClose={closeSheet}
    >
      <View style={styles.modalRoot}>
        <Pressable style={styles.modalBackdrop} onPress={closeSheet} />
        <View style={styles.sheet}>
          <Text variant="caption" color="textMuted">
            {sheetTarget.name}
          </Text>

          {sheetMode === 'menu' ? (
            <>
              <Pressable
                onPress={() => setSheetMode('rename')}
                disabled={busy}
                style={({ pressed }) => [
                  styles.menuItem,
                  { opacity: busy ? 0.4 : pressed ? 0.6 : 1 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`重命名「${sheetTarget.name}」`}
              >
                <Text variant="title">重命名</Text>
              </Pressable>

              <Pressable
                onPress={() => {
                  void duplicateTemplate(sheetTarget);
                }}
                disabled={busy}
                style={({ pressed }) => [
                  styles.menuItem,
                  { opacity: busy ? 0.4 : pressed ? 0.6 : 1 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`复制「${sheetTarget.name}」`}
              >
                <Text variant="title">复制这一套</Text>
              </Pressable>

              <Pressable
                onPress={() => confirmDelete(sheetTarget)}
                disabled={busy}
                style={({ pressed }) => [
                  styles.menuItem,
                  { opacity: busy ? 0.4 : pressed ? 0.6 : 1 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`删除「${sheetTarget.name}」`}
              >
                <Text variant="title" style={styles.menuDanger}>
                  删除
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              <TextInput
                style={styles.input}
                value={renameText}
                onChangeText={setRenameText}
                // 占位文字必须跟着主题走，否则浅色主题下会是几乎看不见的白
                placeholderTextColor={palette.textFaint}
                placeholder="计划名，比如「推日」"
                autoFocus
                returnKeyType="done"
                onSubmitEditing={() => {
                  void submitRename(sheetTarget);
                }}
              />
              <Button
                label="保存"
                onPress={() => {
                  void submitRename(sheetTarget);
                }}
              />
            </>
          )}

          <Pressable
            onPress={closeSheet}
            style={({ pressed }) => [
              styles.menuItem,
              { opacity: pressed ? 0.6 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="取消"
          >
            <Text variant="body" style={styles.menuCancel}>
              取消
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );

  return (
    <Screen edgeToEdgeTop={false}>
      {loading && templates.length === 0 ? (
        <View style={styles.stateBox}>
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : null}

      <FlatList
        style={{ flex: 1 }}
        data={templates}
        keyExtractor={(item) => item.id}
        renderItem={renderRow}
        contentContainerStyle={{ paddingTop: space.md, paddingBottom: space.lg }}
        // 说明文字与「＋ 新建计划」都挂在表头/表尾：用 FlatList 而不是
        // ScrollView + map，是为了长列表下不必把所有行都渲染出来
        ListHeaderComponent={
          <View style={styles.intro}>
            <Text variant="caption" color="textMuted">
              开始训练时会按下面的顺序自动轮转。
            </Text>
            <Text variant="caption" color="textMuted">
              老用户先建一套（或几套）计划，之后的每场训练就不必再手动挑动作。
            </Text>
          </View>
        }
        ListEmptyComponent={renderEmpty()}
        ListFooterComponent={
          templates.length > 0 ? (
            <Button
              label="＋　新建计划"
              variant="secondary"
              onPress={() => openEditor('new')}
              accessibilityLabel="新建计划"
              style={{ marginTop: space.md }}
            />
          ) : null
        }
      />

      {sheet}
    </Screen>
  );
}

/**
 * 这一屏用到的全部样式。
 *
 * **写成 hook 而不是模块级的 `StyleSheet.create`**：颜色来自主题，而主题在运行时
 * 才定（跟随系统明暗）。模块级常量在模块加载时就固化了，拿不到主题。
 *
 * 布局类样式（间距、方向、对齐）走 `src/ui` 的 token；只有颜色取自 palette。
 *
 * @returns 绑定了当前主题的样式对象
 */
function usePlanListStyles() {
  const palette = usePalette();

  return useMemo(
    () => ({
      intro: { gap: space.xs, marginBottom: space.md },

      row: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: space.md,
        paddingVertical: space.md,
        borderBottomWidth: border.hairline,
        borderBottomColor: palette.border,
      },
      // 名字那一栏吃掉剩余宽度；右侧三个按钮固定大小，行与行的按钮才能对齐
      rowText: { flex: 1, gap: space.xs },
      rowActions: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: space.sm,
      },
      iconButton: {
        width: 36,
        height: 36,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderRadius: radius.sm,
        borderWidth: border.hairline,
      },
      iconButtonText: { color: palette.text },

      stateBox: {
        paddingVertical: space.huge,
        gap: space.sm,
        alignItems: 'center' as const,
      },
      stateHint: { textAlign: 'center' as const },
      errorTitle: { color: palette.danger },

      // 底部弹层
      modalRoot: { flex: 1, justifyContent: 'flex-end' as const },
      // 不用 `StyleSheet.absoluteFillObject`：这一版 react-native 的类型里已经
      // 没有这个导出了（只剩 `absoluteFill`），直接写全 absolute 四边更省事
      modalBackdrop: {
        position: 'absolute' as const,
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.55)',
      },
      sheet: {
        backgroundColor: palette.surface,
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.xl,
        gap: space.sm,
      },
      menuItem: {
        paddingVertical: space.md,
        borderBottomWidth: border.hairline,
        borderBottomColor: palette.border,
      },
      menuDanger: { color: palette.danger },
      menuCancel: { color: palette.accent, fontWeight: weight.medium },
      input: {
        backgroundColor: palette.surfaceRaised,
        borderRadius: radius.md,
        borderWidth: border.hairline,
        borderColor: palette.border,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        fontSize: fontSize.body,
        color: palette.text,
      },
    }),
    [palette],
  );
}
