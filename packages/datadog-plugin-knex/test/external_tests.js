'use strict'

const defaultConfig = {
  integration: 'knex',
  repo: 'https://github.com/tgriesser/knex'
}

const testConfigs = [
  {
    testType: 'mocha',
    testArgs: '--exit -t 10000 test/index.js',
    testEnv: {
      'DB': 'sqlite3'
    }
  },
  {
    testType: 'tape',
    testArgs: 'test/tape/index.js',
    testEnv: {
      'DB': 'sqlite3'
    }
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
