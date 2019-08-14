'use strict'

const defaultConfig = {
  integration: 'when',
  repo: 'https://github.com/cujojs/when'
}

const testConfigs = [
  {
    testType: 'buster-test',
    testArgs: '-e node'
  },
  {
    testType: 'promises-aplus-tests',
    testArgs: 'test/promises-aplus-adapter.js'
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
