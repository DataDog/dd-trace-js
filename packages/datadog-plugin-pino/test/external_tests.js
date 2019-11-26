'use strict'

const testConfigs = [
  {
    integration: 'pino',
    repo: 'https://github.com/pinojs/pino',
    framework: 'tap',
    args: '--no-esm -j 4 --no-cov test/*test.js'
  }
]

module.exports = testConfigs
