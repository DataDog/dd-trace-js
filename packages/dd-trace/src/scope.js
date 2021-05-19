'use strict'

const semver = require('semver')
const scopes = require('../../../ext/scopes')

const NOOP = scopes.NOOP

// https://github.com/nodejs/node/pull/33801
const hasJavaScriptAsyncHooks = semver.satisfies(process.versions.node, '>=14.5 || ^12.19.0')

module.exports = name => {
  let Scope

  if (name === NOOP) {
    Scope = require('./scope/base')
  } else if (name === scopes.SYNC) {
    Scope = require('./scope/sync')
  } else if (name === scopes.ASYNC_LOCAL_STORAGE) {
    Scope = require('./scope/async_local_storage')
  } else if (name === scopes.ASYNC_RESOURCE || (!name && hasJavaScriptAsyncHooks)) {
    Scope = require('./scope/async_resource')
  } else {
    Scope = require('./scope/async_hooks')
  }

  return Scope
}
