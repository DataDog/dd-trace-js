'use strict'

const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('../../version')

// Activate the synchronous loader hooks from a plain CJS init too (not only via
// `--import`). On Node versions that ship them they rewrite ESM in place,
// including require(esm) of dual packages like graphql 17, so the integration
// works without the user adding `--import dd-trace/initialize.mjs`.
// Gated to versions with the registerHooks fix; older Node is left to the CJS
// rewriter (+ the dual-package CJS redirect) and stays unaffected here.
// TODO: share this gate with register.js's isSyncLoaderHookVersionSupported.
if (syncLoaderHooksSupported()) {
  require('../../register')
}

require('./src/helpers/bundler-register')
require('./src/helpers/register')
require('./src/helpers/rewriter/loader')

function syncLoaderHooksSupported () {
  if (NODE_MAJOR >= 26) return true
  if (NODE_MAJOR === 25) return NODE_MINOR >= 1
  if (NODE_MAJOR === 24) return NODE_MINOR > 11 || (NODE_MINOR === 11 && NODE_PATCH >= 1)
  if (NODE_MAJOR === 22) return NODE_MINOR > 22 || (NODE_MINOR === 22 && NODE_PATCH >= 3)
  return false
}
