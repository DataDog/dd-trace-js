const jest = require('jest')

const options = {
  projects: [__dirname],
  testPathIgnorePatterns: ['/node_modules/'],
  cache: false,
  maxWorkers: '50%',
  testRegex: /test\/ci-visibility-test/,
  coverage: true,
  passWithNoTests: true,
  runInBand: true
}

jest.runCLI(
  options,
  options.projects
).then(() => {
  if (process.send) {
    process.send('finished')
  }
})
