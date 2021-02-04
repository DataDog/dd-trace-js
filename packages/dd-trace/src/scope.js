'use strict'

const semver = require('semver')
const scopes = require('../../../ext/scopes')

const NOOP = scopes.NOOP

const hasJavaScriptHooks = semver.satisfies(process.versions.node, '>=14.5 || ^12.19.0')

module.exports = name => {
  let Scope

  if (name === NOOP) {
    Scope = require('./scope/base')
  } else if (name === scopes.ASYNC_LOCAL_STORAGE) {
    Scope = require('./scope/async_local_storage')
  } else if (name === scopes.ASYNC_RESOURCE || (!name && hasJavaScriptHooks)) {
    Scope = require('./scope/async_resource')
  } else {
    Scope = require('./scope/async_hooks')
  }

  return Scope
}
