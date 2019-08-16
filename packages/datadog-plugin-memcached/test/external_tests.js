'use strict'

const testConfigs = [
  {
    integration: 'memcached',
    repo: 'https://github.com/3rd-Eden/memcached',
    framework: 'mocha',
    args: "$(find test -name '*.test.js') --exit"
  }
]

module.exports = testConfigs
