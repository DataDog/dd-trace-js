'use strict'

const testConfigs = [
  {
    integration: 'redis',
    repo: 'https://github.com/NodeRedis/node_redis',
    framework: 'mocha',
    args: './test/*.js ./test/commands/*.js --exit --timeout 8000'
  }
]

module.exports = testConfigs
