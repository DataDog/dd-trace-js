'use strict'

const defaultConfig = {
  integration: 'when',
  repo: 'https://github.com/cujojs/when'
}

const testConfigs = [
  {
    name: 'when -- master -- buster-test',
    testType: 'buster-test',
    testArgs: '-e node'
  },
  {
    name: 'when -- master -- promises-aplus-tests',
    testType: 'promises-aplus-tests',
    testArgs: 'test/promises-aplus-adapter.js'
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
