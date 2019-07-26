'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'pino',
  repo: 'https://github.com/pinojs/pino',
  testType: 'tap',
  testArgs: '--no-esm -j 4 --no-cov test/*test.js',
  setup: function (cwd) {
    execSync('npm install', { cwd })
  }
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
