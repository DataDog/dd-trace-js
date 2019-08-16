'use strict'

const testConfigs = [
  {
    integration: 'bluebird',
    repo: 'https://github.com/petkaantonov/bluebird',
    framework: 'node',
    args: '--expose-gc tools/test.js',
    env: {
      '_DD_PATCH_SPAWN': true
    }
  }
]

module.exports = testConfigs
