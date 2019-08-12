'use strict'

const defaultConfig = {
  integration: 'restify',
  repo: 'https://github.com/restify/node-restify/'
}

const testConfigs = [
  {
    testType: 'mocha',
    testArgs: '--exit --full-trace test/plugins/*.test.js'
  },
  {
    testType: 'nodeunit',
    testArgs: 'test/*.test.js'
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
