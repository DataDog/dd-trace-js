'use strict'

const defaultConfig = {
  integration: 'winston',
  repo: 'https://github.com/winstonjs/winston/',
  testType: 'mocha',
  testArgs: 'test/*.test.js test/**/*.test.js --exit'
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
