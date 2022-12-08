const jest = require('jest')

const options = {
  projects: [__dirname],
  testPathIgnorePatterns: ['/node_modules/'],
  cache: false,
  maxWorkers: '50%',
  testRegex: 'test/ci-visibility-test.js'
}

jest.runCLI(
  options,
  options.projects
).then(() => {
  process.send('finished')
})
