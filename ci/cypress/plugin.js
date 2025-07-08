'use strict'

const { NODE_MAJOR } = require('../../version')

// These polyfills are here because cypress@6.7.0, which we still support for v5, runs its plugin code
// with Node.js@12.
if (NODE_MAJOR < 18) {
  require('./polyfills')
}

require('../init')

module.exports = require('../../packages/datadog-plugin-cypress/src/plugin')
