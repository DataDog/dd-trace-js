'use strict'

const defaultConfig = {
  integration: 'bunyan',
  repo: 'https://github.com/trentm/node-bunyan',
  testType: 'nodeunit',
  testArgs: '$(ls -1 test/*.test.js | grep -v dtrace | xargs)'
}

const testConfigs = [
  {
    branch: 'master'
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
