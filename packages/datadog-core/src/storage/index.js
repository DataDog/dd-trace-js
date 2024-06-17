'use strict'

// TODO: default to AsyncLocalStorage when it supports triggerAsyncResource

const semver = require('semver')

// https://github.com/nodejs/node/pull/33801
const hasJavaScriptAsyncHooks = semver.satisfies(process.versions.node, '>=14.5')

if (typeof Deno !== 'undefined') {
  module.exports = require('./async_local_storage')
} else if (hasJavaScriptAsyncHooks) {
  module.exports = require('./async_resource')
} else {
  module.exports = require('./async_hooks')
}
