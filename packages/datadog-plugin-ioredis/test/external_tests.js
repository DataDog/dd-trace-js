'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'ioredis',
  repo: 'https://github.com/luin/ioredis',
  testType: 'mocha',
  testArgs: '"test/**/*.ts"',
  setup: function (cwd) {
    execSync('npm install && npm run build', { cwd })
  },
  env: {
    'TS_NODE_TRANSPILE_ONLY': true,
    'TS_NODE_LOG_ERROR': true,
    'NODE_ENV': 'test'
  }
}

module.exports = {
  defaultConfig
}
