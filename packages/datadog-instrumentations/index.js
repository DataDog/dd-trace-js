'use strict'

const Module = require('module')

const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('../../version')

// Activate the synchronous loader hooks from a plain CJS init too (not only via
// `--import`). On Node versions that ship them they rewrite ESM in place,
// including require(esm) of dual packages like graphql 17, so the integration
// works without the user adding `--import dd-trace/initialize.mjs`.
//
// The root register.js calls `module.register('./loader-hook.mjs')` — an
// `--import`-style ESM bootstrap that must never enter the application's own
// module graph: a bundler (esbuild/webpack) would try to resolve loader-hook.mjs
// relative to the bundle output and fail, and there is nothing to instrument via
// the ESM loader inside a bundle anyway. So reach it only in real Node (the
// module wrapper is a Module instance; in a bundle it is a plain object) and via
// a runtime-built specifier the bundler cannot statically follow.
// TODO: share this gate with register.js's isSyncLoaderHookVersionSupported.
if (module instanceof Module && syncLoaderHooksSupported()) {
  Module.createRequire(__filename)(['..', '..', 'register'].join('/'))
}

require('./src/helpers/bundler-register')
require('./src/helpers/register')
require('./src/helpers/rewriter/loader')

function syncLoaderHooksSupported () {
  // Electron's built-in modules live behind virtual `electron/js2c/*` paths with
  // no file on disk, so iitm's synchronous load hook throws ENOENT trying to read
  // them. Electron apps that want ESM instrumentation still use `--import`; don't
  // auto-register the sync hooks from the CommonJS init path here.
  if (process.versions.electron !== undefined) return false
  if (NODE_MAJOR >= 26) return true
  if (NODE_MAJOR === 25) return NODE_MINOR >= 1
  if (NODE_MAJOR === 24) return NODE_MINOR > 11 || (NODE_MINOR === 11 && NODE_PATCH >= 1)
  if (NODE_MAJOR === 22) return NODE_MINOR > 22 || (NODE_MINOR === 22 && NODE_PATCH >= 3)
  return false
}
