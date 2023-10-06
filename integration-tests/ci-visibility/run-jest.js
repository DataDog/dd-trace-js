const jest = require('jest')

const options = {
  projects: [__dirname],
  testPathIgnorePatterns: ['/node_modules/'],
  cache: false,
  testRegex: process.env.TESTS_TO_RUN ? new RegExp(process.env.TESTS_TO_RUN) : /test\/ci-visibility-test/,
  coverage: true,
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

jest.runCLI(
  options,
  options.projects
).then(() => {
  if (process.send) {
    process.send('finished')
  }
})
