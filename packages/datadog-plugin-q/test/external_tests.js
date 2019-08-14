'use strict'

const defaultConfig = {
  integration: 'q',
  repo: 'https://github.com/kriskowal/q'
}

const testConfigs = [
  {
    testType: 'promises-aplus-tests',
    testArgs: 'spec/aplus-adapter'
  },
  {
    testType: 'jasmine-node',
    testArgs: 'spec'
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
