'use strict'

const normalizeTestConfigs = require('../../../scripts/helpers/normalizeTestConfigs')

const defaults = {
  integration: 'hapi',
  repo: 'https://github.com/hapijs/hapi',
  framework: 'lab',
  args: '-a @hapi/code -m 3000 test/'
}

const testConfigs = [
  {
    branch: 'v16-commercial',
    args: '-a code -m 3000 -l test/'
  },
  {
    branch: 'v17'
  },
  {
    branch: 'v18-commercial'
  }
]

module.exports = normalizeTestConfigs(testConfigs, defaults)
