'use strict'

const defaultConfig = {
  integration: 'generic-pool',
  repo: 'https://github.com/coopernurse/node-pool',
  testType: 'tap',
  testArgs: 'test/*-test.js',
  branch: 'v2.5'
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
