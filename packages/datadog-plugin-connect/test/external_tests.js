'use strict'

const defaultConfig = {
  integration: 'connect',
  repo: 'https://github.com/senchalabs/connect/',
  pretestCmd: 'npm install',
  testType: 'mocha',
  testArgs: '--require test/support/env --reporter spec --bail --check-leaks test/'
}

const testConfigs = [
  {
    branch: '2.30.2'
  },
  {
    branch: '3.0.0'
  },
  {
    branch: undefined
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
