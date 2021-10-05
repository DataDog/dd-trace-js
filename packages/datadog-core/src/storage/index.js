'use strict'

const semver = require('semver')

const { DD_TRACE_SCOPE } = process.env

// https://github.com/nodejs/node/pull/33801
const hasJavaScriptAsyncHooks = semver.satisfies(process.versions.node, '>=14.5 || ^12.19.0')

if (DD_TRACE_SCOPE === 'noop') {
  module.exports = require('./noop')
} else if (DD_TRACE_SCOPE === 'sync') {
  module.exports = require('./sync')
} else if (DD_TRACE_SCOPE === 'async_local_storage') { // TODO: make this the default
  module.exports = require('async_hooks').AsyncLocalStorage
} else if (DD_TRACE_SCOPE === 'async_resource' || (!DD_TRACE_SCOPE && hasJavaScriptAsyncHooks)) {
  module.exports = require('./async_resource')
} else {
  module.exports = require('./async_hooks')
}
