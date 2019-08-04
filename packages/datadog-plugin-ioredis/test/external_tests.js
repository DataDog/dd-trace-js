'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'ioredis',
  repo: 'https://github.com/luin/ioredis',
  testType: 'mocha',
  testArgs: '\"test/**/*.ts\"', // eslint-disable-line no-useless-escape
  setup: function (cwd) {
    execSync('npm install && npm run build', { cwd })
  },
  env: {
    'TS_NODE_TRANSPILE_ONLY': true,
    'TS_NODE_LOG_ERROR': true,
    'NODE_ENV': 'test'
  }
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
