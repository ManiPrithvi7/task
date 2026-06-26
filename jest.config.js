/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  clearMocks: true,
  forceExit: true,
  detectOpenHandles: false,
  maxWorkers: 1,
  testTimeout: 120000,
  globals: {
    'ts-jest': {
      tsconfig: {
        types: ['node', 'jest'],
        baseUrl: '.',
        paths: {
          '@/*': ['src/*']
        }
      }
    }
  }
};
