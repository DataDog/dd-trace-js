'use strict'

const testConfigs = [
  {
    integration: 'generic-pool',
    repo: 'https://github.com/coopernurse/node-pool',
    framework: 'tap',
    args: 'test/*-test.js',
    branch: 'v2.5'
  }
]

module.exports = testConfigs
