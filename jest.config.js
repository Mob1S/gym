module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['babel-jest', { configFile: '<rootDir>/babel.config.test.js' }],
  },
};
