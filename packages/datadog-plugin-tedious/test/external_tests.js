'use strict'

const testConfigs = {
  integration: 'tedious',
  repo: 'https://github.com/tediousjs/node-mssql',
  framework: 'mocha',
  args: '--exit -t 15000 test/common/unit.js test/tedious'
}

module.exports = testConfigs
