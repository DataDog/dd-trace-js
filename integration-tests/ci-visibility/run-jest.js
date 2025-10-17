'use strict'

const jest = require('jest')

const options = {
  projects: [__dirname],
  testPathIgnorePatterns: ['/node_modules/'],
  cache: false,
  testRegex: process.env.TESTS_TO_RUN ? new RegExp(process.env.TESTS_TO_RUN) : /test\/ci-visibility-test/,
  coverage: !!process.env.ENABLE_CODE_COVERAGE,
  runInBand: true,
  shard: process.env.TEST_SHARD || undefined
}

if (process.env.RUN_IN_PARALLEL) {
  delete options.runInBand
  options.maxWorkers = 2
}

if (process.env.OLD_RUNNER) {
  options.testRunner = 'jest-jasmine2'
}

if (process.env.ENABLE_JSDOM) {
  options.testEnvironment = 'jsdom'
}

if (process.env.ENABLE_HAPPY_DOM) {
  options.testEnvironment = '@happy-dom/jest-environment'
}

if (process.env.COLLECT_COVERAGE_FROM) {
  options.collectCoverageFrom = process.env.COLLECT_COVERAGE_FROM.split(',')
}

jest.runCLI(
  options,
  options.projects
).then((results) => {
  if (process.send) {
    process.send('finished')
  }
  if (process.env.SHOULD_CHECK_RESULTS) {
    const exitCode = results.results.success ? 0 : 1
    process.exit(exitCode)
  }
})
