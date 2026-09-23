import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';

import type { SqlExecutor } from '../db/types';
import type { BackupFile } from '../domain/backup';
import { validateBackup } from '../domain/backup';
import { exportAll, importAll } from '../repositories/backupRepo';
import { getActiveSession, listSessions } from '../repositories/sessionRepo';

/**
 * 备份的文件读写层：把「库里的数据」和「手机上的文件 + 系统分享/选择面板」接起来。
 *
 * 这一层依赖三个 expo 原生模块，**在 Node 下跑不了，因此没有单测**。凡是能在 Node 里
 * 验证的东西（备份格式的构造与校验、事务化的读写）都已经在 `domain/backup.ts` 与
 * `repositories/backupRepo.ts` 里测过了，这里只负责编排与「把异常翻译成人话」。
 *
 * 两条硬规则：
 *  1. **校验先于写入。** 从文件读来的东西在 `validateBackup` 通过之前，一个字节都不写库。
 *  2. **不把异常冒到界面。** 所有失败都返回 `{ ok: false, message }`，`message` 必须
 *     是用户看得懂的中文 —— 一段英文异常栈等于没有错误处理。唯一抛异常的是
 *     `shareBackup`（它的签名是 `Promise<void>`，没有返回值可以携带失败信息）。
 */

/**
 * 用户主动取消时返回的文案。
 *
 * 取消不是错误，界面层不该为它弹红字提示，但 `{ ok, message }` 里没有第三个字段可以
 * 承载「这是取消」这个信息，所以用一个导出的常量来做约定 —— 比让界面去猜字符串前缀稳。
 */
export const CANCELED_MESSAGE = '已取消';

/** 备份文件名带日期：用户会在「文件」或网盘里攒下好几份，没日期就分不清哪份是哪份 */
/**
 * @param exportedAt 备份里的导出时间戳（不是「现在」——两者必须同一个值）
 * @returns 形如 `gym-backup-2026-09-21.json`
 */
function backupFileName(exportedAt: number): string {
  const date = new Date(exportedAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  // 用本地时间而不是 UTC：文件的日期要对得上用户记忆里「哪天导的」。
  // toISOString() 在东八区会把傍晚之后的导出记成前一天。
  return `gym-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

/**
 * 底层异常的原始信息，作为括号里的细节附在人话后面。
 *
 * @param error 捕到的任意值（**catch 到的不是 Error 是常态**，比如原生模块抛字符串）
 * @returns 异常消息；不是 Error 时用 `String()` 兜底
 */
function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `Alert.alert` 是回调式的、没有返回值，包成 Promise 才能 `await`。
 *
 * `cancelable: false` 不是可选项：Android 上点对话框外面或按返回键会把它关掉，
 * 而且**不触发任何按钮回调** —— 那样这个 Promise 永远不 resolve，界面上的按钮
 * 就会一直卡在「禁用 + 进行中」。宁可要求用户显式选一个。
 */
/**
 * @param message 对话框正文：会用多少场替换当前多少场（由调用方拼好）
 * @returns 用户点了「替换并导入」为 true，点「取消」为 false。
 *          **不会一直挂着不 resolve** —— 见上方 `cancelable: false` 的说明
 */
function confirmReplace(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      '确认导入备份？',
      message,
      [
        { text: '取消', style: 'cancel', onPress: () => resolve(false) },
        { text: '替换并导入', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: false },
    );
  });
}

/**
 * 导出整库并打开系统分享面板，让用户自己发到微信 / 邮件 / 网盘。
 *
 * 写到**缓存目录**而不是文档目录：这份文件只是分享的中转站，用户存到哪里由他在分享
 * 面板里决定。缓存目录由系统在空间紧张时回收，正好省得我们自己去清理。
 *
 * 失败时抛异常（签名是 `Promise<void>`，没有地方放失败信息），但抛出的**必须是**已经
 * 翻译好的中文 `Error`，调用方直接 `error.message` 就能弹给用户。
 */
/**
 * @param exec SQL 执行器
 * @returns 分享面板关闭后 resolve
 * @throws 读库失败、写文件失败、没有分享面板、面板打不开，四种情况各抛一条
 *         已翻译好的中文 `Error`。**调用方直接读 `error.message` 弹给用户即可**，
 *         不要再拼一层前缀
 */
export async function shareBackup(exec: SqlExecutor): Promise<void> {
  let backup: BackupFile;
  try {
    backup = await exportAll(exec);
  } catch (error) {
    throw new Error(`读不出训练记录，备份没有生成（${detail(error)}）`);
  }

  // 文件名用 `backup.exportedAt` 而不是再读一次时钟：文件里的时间戳和文件名必须一致，
  // 否则用户按文件名找回来的那份，内容里的导出时间会对不上。
  const file = new File(Paths.cache, backupFileName(backup.exportedAt));
  try {
    // 新版 API 的 `write` 会自动建文件、重复写则覆盖，不需要先 `create()`
    // （`create()` 在文件已存在时会抛错，同一天导出第二次就会炸）。
    file.write(JSON.stringify(backup, null, 2));
  } catch (error) {
    throw new Error(
      `备份文件没能写到手机上，可能是存储空间不足（${detail(error)}）`,
    );
  }

  let sharingAvailable = false;
  try {
    sharingAvailable = await Sharing.isAvailableAsync();
  } catch {
    sharingAvailable = false;
  }
  if (!sharingAvailable) {
    throw new Error('这台设备没有可用的系统分享面板，没法把备份文件发出去');
  }

  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      UTI: 'public.json',
      dialogTitle: '导出训练备份',
    });
  } catch (error) {
    // 文件已经写好了，只是分享面板没开起来 —— 告诉用户这份文件还在，重试即可，
    // 不要让他以为白导了一次。
    throw new Error(
      `分享面板没能打开，备份文件还在 App 的缓存里，可以重试（${detail(error)}）`,
    );
  }
}

/**
 * 选一个备份文件并导入。**整库替换**。
 *
 * 控制流按「先验证、后确认、最后才写」排，每一个失败分支都在写库之前返回：
 *
 * ```
 * 选文件 ──取消──▶ { ok:false, message: 已取消 }         （不是错误，界面不弹红字）
 *   │
 *   ├─读文件失败──▶ 人话 + 原始细节                        （库里没动）
 *   ├─JSON.parse 失败──▶ 「这不是一个有效的 JSON 文件」     （库里没动）
 *   ├─validateBackup 不过──▶ 原样返回 reason               （库里没动，一个字节都没写）
 *   │
 *   └─校验通过──▶ 数当前场数 ──▶ 二次确认 ──取消──▶ 已取消
 *                                  │
 *                                  └─确认──▶ importAll（一个事务）
 *                                              ├─成功──▶ { ok:true, message: 已导入 N 场训练 }
 *                                              └─抛错──▶ 人话 + 「数据没有被改动」
 * ```
 */
/**
 * @param exec SQL 执行器
 * @returns `{ ok: true, message }` 表示已导入；`{ ok: false, message }` 覆盖
 *          取消、选错文件、格式不合法、写入失败等全部失败路径。
 *          调用方拿 `message !== CANCELED_MESSAGE` 判断该不该弹红字
 */
export async function pickAndImportBackup(
  exec: SqlExecutor,
): Promise<{ ok: boolean; message: string }> {
  // 1. 选文件。限定 application/json，用户就不用在一堆文件里自己找。
  let picked: DocumentPicker.DocumentPickerResult;
  try {
    picked = await DocumentPicker.getDocumentAsync({
      type: 'application/json',
      // 默认就是 true，显式写出来：只有复制到 App 缓存目录，我们才拿得到
      // 一个能直接读的 file:// 路径（否则是 content:// 的 SAF URI）。
      copyToCacheDirectory: true,
      multiple: false,
    });
  } catch (error) {
    return { ok: false, message: `没能打开文件选择器（${detail(error)}）` };
  }

  // 2. 取消不是错误
  if (picked.canceled) {
    return { ok: false, message: CANCELED_MESSAGE };
  }

  const asset = picked.assets[0];
  if (!asset) {
    return { ok: false, message: '没有选中任何文件，训练记录没有被改动' };
  }

  // 3. 读文件内容
  let raw: string;
  try {
    raw = await new File(asset.uri).text();
  } catch (error) {
    return {
      ok: false,
      message: `读不出这个文件的内容，可能它已经被删除或没有访问权限（${detail(error)}）`,
    };
  }

  // 4. 解析 JSON。这是最容易被用户撞到的一步（选错了图片、选了一个 PDF），
  //    所以文案要直白到「不用看第二遍就知道该换一个文件」。
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: '这不是一个有效的 JSON 文件，请选择本 App 导出的备份文件' };
  }

  // 5. 校验。不过就整份拒绝 —— 这一步之后才有任何写入。
  const validation = validateBackup(parsed);
  if (!validation.ok) {
    // `reason` 是 `domain/backup.ts` 里逐字段拼出来的人话（带第几条、哪个字段、
    // 收到了什么），原样透传即可，不要在这里二次加工。
    return { ok: false, message: validation.reason };
  }
  const backup = validation.backup;
  const incoming = backup.data.sessions.length;

  // 6. 数一下「当前有多少场」放进确认文案。用户看不到规模就不会认真读这句话。
  let current = 0;
  let hasUnfinished = false;
  try {
    // `listSessions` 只返回**已结束**的训练，所以「进行中的那一场」要单独问
    // `getActiveSession` —— 它同样会被 importAll 删掉，漏报就是骗用户。
    const [finishedSessions, activeSession] = await Promise.all([
      listSessions(exec, 1000),
      getActiveSession(exec),
    ]);
    current = finishedSessions.length;
    hasUnfinished = activeSession !== null;
  } catch (error) {
    return {
      ok: false,
      message: `数不出当前有多少场训练，导入已中止（${detail(error)}）`,
    };
  }

  const question =
    `将用备份里的 ${incoming} 场训练替换当前的 ${current} 场训练，此操作不可撤销。` +
    (hasUnfinished
      ? '\n\n另外，当前还有一次没结束的训练，它不在上面的场数里，但同样会被删除且无法恢复。'
      : '');

  // 7. 二次确认
  const confirmed = await confirmReplace(question);
  if (!confirmed) {
    return { ok: false, message: CANCELED_MESSAGE };
  }

  // 8. 写入。`importAll` 跑在一个事务里，抛错即回滚 —— 所以这里的文案可以
  //    明确承诺「数据没有被改动」，这不是安慰话，是事务给的保证。
  try {
    await importAll(exec, backup);
  } catch (error) {
    return {
      ok: false,
      message: `导入失败，训练记录没有被改动（${detail(error)}）`,
    };
  }

  return { ok: true, message: `已导入 ${incoming} 场训练` };
}
