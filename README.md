# Gym Tracker

一个专注于力量训练记录的移动端 App，使用 Expo + React Native 构建，数据存储在本地 SQLite。

## 功能

- **训练计划**：自定义几套分化（推日 / 拉日 / 腿日……），开始训练时按顺序自动轮转；没建计划时沿用上一次的动作组合。
- **记录每组**：通过大数字拖动或加减按钮快速调整重量（kg）和次数。
- **增删动作**：训练中随时添加或删除动作，练到一半想换也来得及。
- **组间休息**：完成每组后自动开始正计时休息，基于时间戳计算，App 被挂起也不漏秒。
- **训练总结**：查看训练时长、总组数、总容量（volume load）以及组间休息回顾。
- **历史记录**：按时间倒序查看过往训练，点击进入详情。
- **删除记录**：历史列表与详情页都能删掉一整场训练（连同它记下的那些组）。
- **导入记录**：从其他 App 导入 CSV，或手动补记一条，进步曲线能接上之前的过程。
- **备份导出/导入**：将整库导出为 JSON 备份，或从备份文件整库替换恢复。

## 技术栈

- Expo ~57
- React 19.2 / React Native 0.86.3
- TypeScript 6.0（严格模式）
- expo-sqlite
- Zustand
- Jest（单元测试）

## 目录结构

```
app/                      # expo-router 页面
  (tabs)/                 # 底部标签页
    index.tsx             # 训练
    history.tsx           # 历史
    progress.tsx          # 进步（占位）
    settings.tsx          # 设置
  session/[id].tsx        # 训练记录界面
  session/summary/[id].tsx # 训练总结
  history/[id].tsx        # 历史详情
src/
  components/             # 可复用 UI 组件
  db/                     # 数据库 schema、迁移、执行器
  domain/                 # 纯业务逻辑与类型
  lib/                    # 工具函数
  repositories/           # 数据访问层
  store/                  # Zustand 状态
```

## 运行

```bash
npm install
npx expo start
```

## 测试

```bash
npm test              # 单元测试（25 个文件 / 304 条断言，约 2 秒）
npm run typecheck
npm run verify:e2e    # 端到端回归（见下）
```

`npm test` 跑的全是**分层**测试：仓储测仓储、store 测 store、纯函数测纯函数。
分层全绿仍然可能因为层与层之间的假设不一致而在真机上坏掉 —— 例如
「按计划开训练 → 练完 → 结束 → 再看轮转」这一条链跨了
`domain/rotation` / `templateRepo` / `sessionRepo` / `setRepo` / `store/activeSession`
五处，而没有任何一个分层测试覆盖它。

`npm run verify:e2e` 补的就是这条链：在真实 SQLite（`node:sqlite`）上把五条主旅程
串起来跑（分化轮转绕回、训练中删动作的两条分支、导入接到已有进步曲线上、
不建计划的用户行为不变、删计划不伤历史）。它比单元测试慢，所以**不在**
`npm test` 里，需要时单独跑。

它**不覆盖**渲染、手势、原生模块，也覆盖不到真机上 `expo-sqlite` 与
`node:sqlite` 的实现差异 —— 因此它不能替代真机验收。

## 数据模型

- `exercise`：动作库（含预置动作和自定义动作）
- `split_template`：一套分化计划（推日 / 拉日 / 腿日……），列表里的顺序就是轮转顺序
- `template_exercise`：计划里的动作及顺序
- `session`：一次训练；`template_id` 记下这一场是按哪套计划练的，下一次该练哪套由它推导
- `session_exercise`：训练中的动作及顺序
- `set_entry`：每组记录，含重量、次数、完成状态、休息时长

## 设计原则

- **完成即落盘**：每组点击完成后立即写入数据库，中途退出不丢数据。
- **时间戳计时**：休息计时使用 `restStartedAt` 时间戳，而非累加器。
- **过期休息清理**：超过 30 分钟的未结束休息会被自动清理，避免污染数据。
- **备份安全第一**：导入前逐字段校验备份格式，整库替换跑在单一事务中，失败自动回滚。
- **轮转指针不单独存**：下一次该练哪套从 `session.template_id` 推导，不额外维护一个指针 —— 少一处需要同步的状态。
- **导入只有一条落库路径**：CSV 与手动补记产出同一种中间结构，共用 `importRepo`；两条路各写一份插入逻辑迟早会走偏。
