'use strict'

const testConfigs = [
  {
    integration: 'bunyan',
    repo: 'https://github.com/trentm/node-bunyan',
    framework: 'nodeunit',
    args: '$(ls -1 test/*.test.js | grep -v dtrace | xargs)'
  }
]

module.exports = testConfigs
