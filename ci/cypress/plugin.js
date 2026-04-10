'use strict'

const { channel } = require('dc-polyfill')
const { NODE_MAJOR } = require('../../version')

// These polyfills are here because cypress@6.7.0, which we still support for v5, runs its plugin code
// with Node.js@12.
if (NODE_MAJOR < 18) {
  require('./polyfills')
}

require('../init')

// In the manual plugin scenario the Cypress plugin process never requires the
// 'cypress' npm package itself, so the normal addHook path that fires
// 'dd-trace:instrumentation:load' for 'cypress' never runs and the
// CypressPlugin singleton is never instantiated.  Publish the channel manually
// so the plugin manager creates the instance and subscribes to the
// ci:cypress:* channels before the caller invokes the exported function.
channel('dd-trace:instrumentation:load').publish({ name: 'cypress' })

module.exports = require('../../packages/datadog-plugin-cypress/src/plugin')
