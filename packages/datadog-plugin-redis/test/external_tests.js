'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'redis',
  repo: 'https://github.com/NodeRedis/node_redis',
  testType: 'mocha',
  testArgs: './test/*.js ./test/commands/*.js --timeout 8000',
  setup: function (cwd) {
    return execSync('npm install', { cwd })
  }
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
