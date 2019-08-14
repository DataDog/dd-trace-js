'use strict'

const defaultConfig = {
  integration: 'tedious',
  repo: 'https://github.com/tediousjs/node-mssql',
  testType: 'mocha',
  testArgs: '--exit -t 15000 test/common/unit.js test/tedious'
}

module.exports = {
  defaultConfig
}
