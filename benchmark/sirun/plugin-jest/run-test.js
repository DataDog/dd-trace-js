'use strict'
const path = require('path')

const jest = require('../../../versions/jest').get()

const options = {
  projects: [__dirname],
  testPathIgnorePatterns: ['/node_modules/'],
  coverageReporters: [],
  reporters: [],
  silent: true,
  testEnvironment: path.join(__dirname, 'env.js'),
  cache: false,
  testRegex: 'jest-test.js'
}
jest.runCLI(
  options,
  options.projects
)
