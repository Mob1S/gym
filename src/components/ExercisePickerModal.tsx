import { useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, TextInput, View } from 'react-native';

import type { Exercise } from '../domain/types';
import { useDatabase } from '../repositories/database';
import { listExercises } from '../repositories/exerciseRepo';
import { Text } from '../ui/Text';
import { usePalette } from '../ui/theme';
import { border, fontSize, radius, space, tracking, weight } from '../ui/tokens';

/** 肌群为空的自定义动作归到这一组，避免列表里出现没有标题的一段 */
const UNGROUPED_LABEL = '其他';

interface ExerciseGroup {
  title: string;
  data: Exercise[];
}

/**
 * 按肌群分组，组内保持 `listExercises` 给的顺序。
 *
 * `listExercises` 已经按「肌群顺序 + 拼音」排好了（排序逻辑在仓储层，
 * 界面不重排），所以这里只做相邻归并，不排序、不重排。
 *
 * @param exercises `listExercises` 的返回，顺序必须是它排好的那个顺序 ——
 *   这个函数只在相邻两项之间归并，顺序一乱就会把同一个肌群切成好几段，
 *   弹层里会出现一排重复的标题
 * @returns 分段数据，每段自带标题；肌群为空的自定义动作会落在「其他」那一段里，
 *   所以基本不会出现没有标题的一段
 */
function groupByMuscleGroup(exercises: Exercise[]): ExerciseGroup[] {
  const groups: ExerciseGroup[] = [];
  for (const exercise of exercises) {
    const title = exercise.muscleGroup ?? UNGROUPED_LABEL;
    const last = groups[groups.length - 1];
    if (last && last.title === title) {
      last.data.push(exercise);
    } else {
      groups.push({ title, data: [exercise] });
    }
  }
  return groups;
}

/** 弹层入参 */
interface ExercisePickerModalProps {
  /** 是否显示 */
  visible: boolean;
  /** 关闭回调（背景、取消、Android 返回键三条路都汇到它） */
  onClose: () => void;
  /** 选中一个动作 */
  onPick: (exercise: Exercise) => void;
}

/**
 * 选择动作的弹层。记录页、计划编辑页、手动补记录页三处共用。
 *
 * **抽出来的理由不是「少写代码」，而是「只有一份实现」**：这个弹层里有三条
 * 容易写错的约定——动作库只在打开时读一次、搜索按「包含」而不是「前缀」、
 * 肌群分组不能重排仓储给的顺序。三处各写一遍，迟早有一处漏掉其中一条，
 * 而症状是「某个页面里的动作列表莫名其妙少了几项」。
 *
 * @param props.visible 是否显示
 * @param props.onClose 关闭回调（背景、取消、Android 返回键三条路都汇到它）
 * @param props.onPick 选中一个动作。**加失败时调用方不要关弹层** ——
 *   关掉只会让用户以为加上了，对着同一屏反复点
 * @returns 底部弹出的动作列表
 */
export function ExercisePickerModal({
  visible,
  onClose,
  onPick,
}: ExercisePickerModalProps) {
  const exec = useDatabase();

  // 绑定了当前主题的样式
  const styles = usePickerStyles();
  // 弹层里搜索框的占位文字色也要跟主题走，所以在这里也取一份 palette
  const palette = usePalette();

  // 搜索框里的原始输入（未 trim）。空串即不过滤，全库平铺
  const [query, setQuery] = useState('');
  // 动作库全表，只在弹层打开时读一次（见下面那个读它的 effect）
  const [allExercises, setAllExercises] = useState<Exercise[]>([]);

  // 打开时清空搜索词。这件事原来由调用页的 `openPicker` 做，`query` 搬进组件后
  // 只能在这里做 —— 弹层关掉之后组件仍然挂载着，不清的话下次打开会留着上一次的
  // 残留：用户看到的是一份莫名其妙变短的列表，而搜索框里那几个字在小屏上未必
  // 一眼看得见。
  useEffect(() => {
    if (visible) setQuery('');
  }, [visible]);

  // 动作清单只在弹层打开时读一次：训练过程中库里不会新增动作，
  // 每次开弹层都全表重读纯属浪费。
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      const all = await listExercises(exec);
      if (!cancelled) setAllExercises(all);
    })();
    return () => {
      cancelled = true;
    };
  }, [exec, visible]);

  // 过滤按「包含」而不是「前缀」：动作名多是「杠铃卧推」这类词组，用户更可能
  // 只记得中间那两个字。先 trim 再比，否则结尾多打一个空格结果就全空了
  const trimmedQuery = query.trim();
  // 过滤 + 分组每敲一个字重算一次。动作库是几十条的量级，这个代价比维护一份
  // 增量索引小得多，也更不容易出错
  const visibleGroups = useMemo(() => {
    const matched = trimmedQuery
      ? allExercises.filter((e) => e.name.includes(trimmedQuery))
      : allExercises;
    return groupByMuscleGroup(matched);
  }, [allExercises, trimmedQuery]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      // Android 的物理返回键 / 手势返回：不接这个回调，返回键会直接退出整屏。
      onRequestClose={onClose}
    >
      <View style={styles.modalRoot}>
        <Pressable style={styles.modalBackdrop} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text variant="title" style={styles.sheetTitle}>
              选择动作
            </Text>
            <Pressable
              style={styles.sheetCancel}
              onPress={onClose}
              accessibilityLabel="取消"
            >
              <Text variant="body" style={styles.sheetCancelText}>
                取消
              </Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="搜索动作名称"
            // 占位文字必须跟着主题走，否则浅色主题下会是几乎看不见的白
            placeholderTextColor={palette.textFaint}
            returnKeyType="search"
            autoCorrect={false}
          />

          <FlatList
            data={visibleGroups}
            keyExtractor={(group) => group.title}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item: group }) => (
              <View>
                <Text variant="label" style={styles.groupTitle}>
                  {group.title}
                </Text>
                {group.data.map((exercise) => (
                  <Pressable
                    key={exercise.id}
                    style={styles.option}
                    onPress={() => {
                      onPick(exercise);
                    }}
                  >
                    <Text variant="body" style={styles.optionText}>
                      {exercise.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            ListEmptyComponent={
              <Text style={styles.emptyHint}>
                {allExercises.length === 0
                  ? '动作库是空的'
                  : `没有找到「${trimmedQuery}」`}
              </Text>
            }
          />
        </View>
      </View>
    </Modal>
  );
}

/**
 * 这个弹层用到的全部样式。
 *
 * **写成 hook 而不是模块级的 `StyleSheet.create`**：颜色现在来自主题，而主题在
 * 运行时才定（跟随系统明暗）。模块级常量在模块加载时就固化了，拿不到主题。
 *
 * 布局类样式（间距、方向、对齐）走 `src/ui` 的 token；只有颜色取自 palette。
 * 这样「间距用 4 的倍数、颜色只有主题里有」两条规则在这个弹层里也成立。
 *
 * @returns 绑定了当前主题的样式对象
 */
function usePickerStyles() {
  const palette = usePalette();

  return useMemo(
    () => ({
      // 动作选择弹层
      modalRoot: { flex: 1, justifyContent: 'flex-end' as const },
      // 不用 `StyleSheet.absoluteFillObject`：这一版 react-native 的类型里已经
      // 没有这个导出了（只剩 `absoluteFill`），直接写全 absolute 四边更省事。
      modalBackdrop: {
        position: 'absolute' as const,
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.55)',
      },
      sheet: {
        maxHeight: '80%' as const,
        backgroundColor: palette.surface,
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.xl,
        gap: space.md,
      },
      sheetHeader: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
      },
      sheetTitle: { fontSize: fontSize.title, fontWeight: weight.bold },
      sheetCancel: {
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
      },
      sheetCancelText: {
        fontSize: fontSize.body,
        color: palette.accent,
        fontWeight: weight.medium,
      },
      search: {
        backgroundColor: palette.surfaceRaised,
        borderRadius: radius.md,
        borderWidth: border.hairline,
        borderColor: palette.border,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        fontSize: fontSize.body,
        color: palette.text,
      },
      groupTitle: {
        fontSize: fontSize.label,
        color: palette.textMuted,
        letterSpacing: tracking.label,
        marginTop: space.md,
        marginBottom: space.xs,
      },
      option: {
        paddingVertical: space.md,
        borderBottomWidth: border.hairline,
        borderBottomColor: palette.border,
      },
      optionText: { fontSize: fontSize.body, color: palette.text },
      emptyHint: {
        textAlign: 'center' as const,
        color: palette.textMuted,
        paddingVertical: space.xl,
      },
    }),
    [palette],
  );
}
