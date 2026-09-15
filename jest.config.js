const path = require('path');

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'babel-jest',
      // 必须用绝对路径。<rootDir> 是 jest 自己的占位符，babel 不认识它，
      // 写成 '<rootDir>/babel.config.test.js' 会在第一个测试文件出现时才炸。
      { configFile: path.join(__dirname, 'babel.config.test.js') },
    ],
  },
};
