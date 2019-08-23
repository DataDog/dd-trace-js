'use strict'

const execSync = require('child_process').execSync

const testConfigs = [
  {
    integration: 'redis',
    repo: 'https://github.com/NodeRedis/node_redis',
    framework: 'mocha',
    args: './test/*.js ./test/commands/*.js --exit --timeout 8000',
    setup (tracerSetupPath, options) {
      execSync('docker ps', options)
      execSync('npm install', options)
    }
  }
]

module.exports = testConfigs
