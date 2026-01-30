#!/usr/bin/env node
'use strict'

const jest = require('jest')

const options = {
  projects: [__dirname],
  testMatch: ['**/jest-hooks-test.js'],
  coverageReporters: ['json'],
  coverage: false,
  maxWorkers: 1,
  testEnvironment: 'node'
}

jest.runCLI(options, options.projects)
  .then((result) => {
    if (result.results.success) {
      console.log('All tests passed!')
    } else {
      console.log('Some tests failed')
      process.exit(1)
    }
  })
  .catch((error) => {
    console.error('Error running tests:', error)
    process.exit(1)
  })
