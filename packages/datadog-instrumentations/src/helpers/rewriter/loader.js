'use strict'

const { ensureCompileShim } = require('./compile-shim.js')

require('./register-hook.js')

const fullSyncLoaderSymbol = Symbol.for('dd-trace.loader.full-sync')

if (!globalThis[fullSyncLoaderSymbol]) ensureCompileShim()
