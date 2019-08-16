'use strict'

const normalizeTestConfigs = require('../../../scripts/helpers/normalizeTestConfigs')

const defaults = {
  integration: 'knex',
  repo: 'https://github.com/tgriesser/knex'
}

const testConfigs = [
  {
    framework: 'mocha',
    args: '--exit -t 10000 test/index.js',
    env: {
      'DB': 'sqlite3'
    }
  },
  {
    framework: 'tape',
    args: 'test/tape/index.js',
    env: {
      'DB': 'sqlite3'
    }
  }
]

module.exports = normalizeTestConfigs(testConfigs, defaults)
