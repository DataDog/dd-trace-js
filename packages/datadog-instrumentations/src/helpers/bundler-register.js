'use strict'

const Module = require('module')

const originalRequire = Module.prototype.require

require('./register')

// register.js has now set up ritm (require-in-the-middle). In bundled
// environments (webpack, esbuild), Node.js built-in modules required by
// dd-trace internal modules (e.g. http from request.js) may have been loaded
// before ritm was active. The bundler's module cache then returns those
// pre-loaded modules for any subsequent require() calls, bypassing ritm.
// Re-requiring them via the real Module.prototype.require ensures ritm applies
// their instrumentation hooks.
//
// In regular Node.js, `module` is an instance of Module. In bundlers, the
// module wrapper object is a plain object (not a Module instance), so we use
// that to detect a bundled context and avoid unintended side-effects in
// normal Node.js (e.g. shimmer-wrapping http before ESM modules load).
if (!(module instanceof Module)) {
  const hookedRequire = Module.prototype.require
  for (const name of ['http', 'https']) {
    try {
      hookedRequire.call(module, name)
    } catch {
      // Built-in not available in this environment, skip
    }
  }

  // Webpack stores prefixed and unprefixed builtins under separate module IDs.
  // Seed both from the singleton that RITM patched above without re-entering
  // RITM while either external module is still being initialized.
  Module.prototype.require = originalRequire
  try {
    require('http')
    require('node:http')
    require('https')
    require('node:https')
  } finally {
    Module.prototype.require = hookedRequire
  }
}
