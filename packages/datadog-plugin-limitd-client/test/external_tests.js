'use strict'

const testConfigs = [
  {
    integration: 'limitd-client',
    repo: 'https://github.com/limitd/node-client',
    framework: 'mocha',
    args: '--exit --timeout 10000'
  }
]

module.exports = testConfigs
