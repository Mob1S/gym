const path = require('path');

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  // 在主进程里跑，不起 worker 池。
  //
  // 一是这个仓库的测试量很小（几百条断言、十几秒跑完），并行省不下什么时间；
  // 二是**必须**如此：jest 默认的 worker 池要 fork 带管道的子进程，而在受限的
  // 沙箱环境里那会直接 `Error: spawn EPERM` 崩掉 —— 表现为「一条测试都跑不起来」，
  // 而不是「跑得慢」，排查起来会误以为是代码坏了。
  // `package.json` 的 `test` 脚本里本来就有 `--runInBand`，这里再写一遍是为了
  // 让任何直接调 `npx jest` 的人（包括自动化工具）都得到同样的行为。
  maxWorkers: 1,
  transform: {
    '^.+\\.tsx?$': [
      'babel-jest',
      // 必须用绝对路径。<rootDir> 是 jest 自己的占位符，babel 不认识它，
      // 写成 '<rootDir>/babel.config.test.js' 会在第一个测试文件出现时才炸。
      { configFile: path.join(__dirname, 'babel.config.test.js') },
    ],
  },
};
