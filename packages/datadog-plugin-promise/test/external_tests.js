'use strict'

const defaultConfig = {
  integration: 'promise',
  repo: 'https://github.com/then/promise',
  testType: 'mocha',
  testArgs: 'test/resolver-tests.js test/extensions-tests.js'
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
