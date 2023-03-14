const jest = require('jest')

const options = {
  projects: [__dirname],
  testPathIgnorePatterns: ['/node_modules/'],
  cache: false,
  testRegex: /test\/ci-visibility-test/,
  coverage: true,
  runInBand: true
}

if (process.env.RUN_IN_PARALLEL) {
  delete options.runInBand
  options.maxWorkers = 2
}

jest.runCLI(
  options,
  options.projects
).then(() => {
  if (process.send) {
    process.send('finished')
  }
})
