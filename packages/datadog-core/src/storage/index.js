'use strict'

const semver = require('semver')

// https://github.com/nodejs/node/pull/33801
const hasJavaScriptAsyncHooks = semver.satisfies(process.versions.node, '>=14.5 || ^12.19.0')
const isAsyncLocalStorageStable = semver.satisfies(process.versions.node, '>=16.4')

if (isAsyncLocalStorageStable) {
  module.exports = require('async_hooks').AsyncLocalStorage
} else if (hasJavaScriptAsyncHooks) {
  module.exports = require('./async_resource')
} else {
  module.exports = require('./async_hooks')
}
