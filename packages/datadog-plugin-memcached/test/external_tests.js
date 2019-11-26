'use strict'

const testConfigs = [
  {
    integration: 'memcached',
    ignoreFailure: true,
    repo: 'https://github.com/3rd-Eden/memcached',
    framework: 'mocha',
    args: 'test/*.test.js --exit'
  }
]

module.exports = testConfigs
