'use strict'

const defaultConfig = {
  integration: 'express',
  repo: 'https://github.com/expressjs/express',
  testType: 'mocha',
  testArgs: '--require test/support/env --reporter spec --bail --check-leaks test/ test/acceptance/'
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
