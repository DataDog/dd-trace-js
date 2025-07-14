'use strict'

module.exports = {
  projects: process.env.PROJECTS ? JSON.parse(process.env.PROJECTS) : [__dirname],
  testPathIgnorePatterns: ['/node_modules/'],
  cache: false,
  testMatch: [
    process.env.TESTS_TO_RUN || '**/ci-visibility/test/ci-visibility-test*'
  ]
}
