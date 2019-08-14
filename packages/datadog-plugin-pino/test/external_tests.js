'use strict'

const defaultConfig = {
  integration: 'pino',
  repo: 'https://github.com/pinojs/pino',
  testType: 'tap',
  testArgs: '--no-esm -j 4 --no-cov test/*test.js'
}

module.exports = {
  defaultConfig
}
