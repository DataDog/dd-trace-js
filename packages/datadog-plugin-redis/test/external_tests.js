'use strict'

const defaultConfig = {
  integration: 'redis',
  repo: 'https://github.com/NodeRedis/node_redis',
  testType: 'mocha',
  testArgs: './test/*.js ./test/commands/*.js --timeout 8000'
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
