'use strict'

const execSync = require('child_process').execSync

const testConfigs = [
  {
    integration: 'ioredis',
    repo: 'https://github.com/luin/ioredis',
    framework: 'mocha',
    args: '"test/**/*.ts"',
    setup: function (tracerSetupPath, options) {
      execSync('npm install && npm run build', options)
    },
    env: {
      'TS_NODE_TRANSPILE_ONLY': true,
      'TS_NODE_LOG_ERROR': true,
      'NODE_ENV': 'test'
    }
  }
]

module.exports = testConfigs
