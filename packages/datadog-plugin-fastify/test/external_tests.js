'use strict'

const normalizeTestConfigs = require('../../../scripts/helpers/normalize_test_configs')

const defaults = {
  integration: 'fastify',
  repo: 'https://github.com/fastify/fastify',
  framework: 'tap',
  args: '--no-esm -J test/*.test.js test/*/*.test.js'
}

const testConfigs = [
  {
    branch: '1.x'
  },
  {
    branch: 'master'
  }
]

module.exports = normalizeTestConfigs(testConfigs, defaults)
