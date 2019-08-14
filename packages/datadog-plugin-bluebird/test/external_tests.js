'use strict'

const defaultConfig = {
  integration: 'bluebird',
  repo: 'https://github.com/petkaantonov/bluebird',
  testType: 'node',
  testArgs: '--expose-gc tools/test.js --run=multiple-copies.js',
  testEnv: {
    '_DD_PATCH_SPAWN': true
  }
}

module.exports = {
  defaultConfig
}
