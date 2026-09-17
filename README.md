# Gym Tracker

一个专注于力量训练记录的移动端 App，使用 Expo + React Native 构建，数据存储在本地 SQLite。

## 功能

- **开始训练**：一键开始新训练，自动沿用上一次的动作组合。
- **记录每组**：通过大数字拖动或加减按钮快速调整重量（kg）和次数。
- **组间休息**：完成每组后自动开始正计时休息，基于时间戳计算，App 被挂起也不漏秒。
- **训练总结**：查看训练时长、总组数、总容量（volume load）以及组间休息回顾。
- **历史记录**：按时间倒序查看过往训练，点击进入详情。
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
npm test
npm run typecheck
```

## 数据模型

- `exercise`：动作库（含预置动作和自定义动作）
- `session`：一次训练
- `session_exercise`：训练中的动作及顺序
- `set_entry`：每组记录，含重量、次数、完成状态、休息时长

## 设计原则

- **完成即落盘**：每组点击完成后立即写入数据库，中途退出不丢数据。
- **时间戳计时**：休息计时使用 `restStartedAt` 时间戳，而非累加器。
- **过期休息清理**：超过 30 分钟的未结束休息会被自动清理，避免污染数据。
- **备份安全第一**：导入前逐字段校验备份格式，整库替换跑在单一事务中，失败自动回滚。
