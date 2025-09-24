'use strict'

const jest = require('jest')

const options = {
  projects: [__dirname],
  testPathIgnorePatterns: ['/node_modules/'],
  cache: false,
  maxWorkers: '50%',
  testRegex: /test\/ci-visibility-test/,
  runInBand: true,
  testEnvironment: '<rootDir>/ci-visibility/jest-environment-bad-init.js'
}

jest.runCLI(
  options,
  options.projects
).then(() => {
  if (process.send) {
    process.send('finished')
  }
})
