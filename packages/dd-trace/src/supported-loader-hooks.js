'use strict'

// Single source of truth for "does this runtime support the synchronous loader
// hooks that own both CommonJS and ESM instrumentation?". Required from CommonJS
// (register.js, datadog-instrumentations/index.js) and from the ESM loader realm
// (loader-hook.mjs, via createRequire), so it stays CommonJS and Node 12-safe.
//
// When this returns true, init.js registers the synchronous hooks on the main
// thread and they handle every CommonJS and ESM load; the asynchronous loader
// (module.register / --loader) must not also run, or it double-processes ESM and
// silently drops the export-wrapping shim on CommonJS pulled into an ESM import.

const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('../../../version')

/**
 * Whether the running Node.js version ships the synchronous loader hooks with the
 * nullish-CommonJS-source fix (nodejs/node#59929). Electron is excluded: its
 * built-ins live behind virtual `electron/js2c/*` paths with no file on disk, so
 * import-in-the-middle's synchronous load hook throws ENOENT reading them.
 *
 * @returns {boolean}
 */
function syncLoaderHooksSupported () {
  if (process.versions.electron !== undefined) return false
  if (NODE_MAJOR >= 26) return true
  if (NODE_MAJOR === 25) return NODE_MINOR >= 1
  if (NODE_MAJOR === 24) return NODE_MINOR > 11 || (NODE_MINOR === 11 && NODE_PATCH >= 1)
  if (NODE_MAJOR === 22) return NODE_MINOR > 22 || (NODE_MINOR === 22 && NODE_PATCH >= 3)
  return false
}

module.exports = { syncLoaderHooksSupported }
