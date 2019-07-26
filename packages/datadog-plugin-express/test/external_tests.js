'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'express',
  repo: 'https://github.com/expressjs/express',
  testType: 'mocha',
  testArgs: '--require test/support/env --reporter spec --check-leaks test/ test/acceptance/',
  setup: function (cwd) {
    execSync('npm install', { cwd })
  }
}

const testConfigs = [
  {
    branch: '4.x'
  },
  {
    branch: '5.x'
  },
  {
    branch: undefined
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
