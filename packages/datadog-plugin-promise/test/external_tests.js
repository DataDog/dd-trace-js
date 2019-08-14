'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'promise',
  repo: 'https://github.com/then/promise',
  setup: function (cwd) {
    execSync('npm install && npm build', { cwd })
  }
}

const testConfigs = [
  {
    testType: 'mocha',
    testArgs: '--timeout 200 --slow 99999 "test/**/*"'
  },
  {
    name: 'promise (default branch) - memory leak test',
    testType: 'node',
    testArgs: '--expose-gc test/memory-leak.js'
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
