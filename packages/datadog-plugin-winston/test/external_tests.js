'use strict'

const testConfigs = [
  {
    integration: 'winston',
    repo: 'https://github.com/winstonjs/winston',
    framework: 'mocha',
    args: 'test/*.test.js test/**/*.test.js --exit'
  }
]

module.exports = testConfigs
