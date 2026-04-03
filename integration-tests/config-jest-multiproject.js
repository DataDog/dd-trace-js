'use strict'

module.exports = {
  projects: [
    {
      displayName: 'standard',
      testPathIgnorePatterns: ['/node_modules/'],
      cache: false,
      testMatch: [
        '**/ci-visibility/test/ci-visibility-test*',
      ],
      testRunner: 'jest-circus/runner',
      testEnvironment: 'node',
    },
    {
      displayName: 'node',
      testPathIgnorePatterns: ['/node_modules/'],
      cache: false,
      testMatch: [
        '**/ci-visibility/test/ci-visibility-test*',
      ],
      testRunner: 'jest-circus/runner',
      testEnvironment: 'node',
    },
  ],
}
