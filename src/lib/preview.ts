/**
 * 现在是不是网页预览（`npx expo start --web` 那一套）。
 *
 * **平台解析**：Metro 打包时优先取 `.web.ts`，所以 web 拿到的是同目录的
 * `preview.web.ts`（值为 `true`），iOS / Android 与**测试**都拿这一个（`false`）。
 * 这个仓库里 `repositories/database.tsx` / `database.web.tsx` 用的是同一套机制。
 *
 * ## 为什么不能在同一个文件里判 `Platform.OS`
 *
 * 那需要 `import { Platform } from 'react-native'`，而 react-native 的入口是
 * ESM —— jest 的 `testEnvironment` 是 `node`，它加载不了，于是**任何间接 import
 * 这个常量的模块都会在测试里炸**（实测：`src/store/activeSession.ts` 引了它就
 * 让整个 `activeSession.test.ts` 跑不起来）。拆成两个文件之后，`.ts` 这一份
 * 没有任何 import，node 下也能安全加载。
 *
 * ## 为什么要有这个常量
 *
 * 「哪些功能在网页预览里不可用」是**一张清单**，不是一个散在各处的判断。
 * 判断收敛到这一个常量，四个界面 import 它 —— 将来要给桌面端或别的预览留口子
 * 时只改这一处，而不是去追一遍 `Platform.OS === 'web'`。
 *
 * ## 预览里为什么会有「点不动」的功能
 *
 * web 打包器加载不了 `expo-sqlite`（worker 分块那件事，见 `demoExecutor.ts`
 * 开头），所以预览走的是那个按 SQL 形态分发的内存假库。它只覆盖真机上会发的
 * 那十几条语句：`DELETE FROM session WHERE id = ?` 会先命中它「清空整表」的
 * 分支，`split_template` / `template_exercise` 两张表在它那里根本没有分支。
 *
 * 一个点不动的按钮比没有按钮糟，所以删记录、计划管理、导入这三处入口在预览里
 * **整个不渲染**；计划相关的查询也直接跳过，免得每次操作都往控制台刷一条
 * 「未处理的查询」警告 —— 预览的价值正是「打开就能看清界面有没有问题」，
 * 被警告淹没就失去意义了。
 *
 * @returns 真机与模拟器（iOS / Android）以及单元测试环境下为 `false`；
 *   **web 的值在 `preview.web.ts` 里**
 */
export const isWebPreview = false;
