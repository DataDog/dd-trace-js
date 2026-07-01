'use strict'

/**
 * Native spans module loader.
 *
 * Provides access to the `@datadog/libdatadog` pipeline crate for native span
 * storage. `@datadog/libdatadog` is a required dependency: any failure to load
 * or initialize the pipeline propagates as a hard error so misconfigured
 * installs surface immediately rather than silently dropping spans.
 *
 * Pipeline loading is deferred to first use (lazy) so that simply importing
 * this module from a unit test (or from code that never actually instantiates
 * a tracer) does not require a working pipeline binary. The first call into
 * any of the lazy getters below will throw if libdatadog or the pipeline crate
 * cannot be loaded.
 */

const { storage } = require('../../../datadog-core')

// Cached module references to avoid repeated require() calls
// which can cause infinite recursion if fs plugin is active during require
let NativeSpansInterfaceModule = null
let NativeDatadogSpanModule = null

// Lazily cached on first call. `OpCode` is read on every span_processor
// sampling sync; `WasmSpanState`/`wasmMemory` are only read once (at
// native_spans.js module load) so they don't need separate caches.
let cachedOpCode = null

// Flag to track if we're currently loading a module to prevent recursion
let isLoading = false

let pipeline = null

function getPipeline () {
  if (pipeline) return pipeline
  const libdatadog = require('@datadog/libdatadog')
  pipeline = libdatadog.load('pipeline')
  if (pipeline?.WasmSpanState == null) {
    throw new Error('@datadog/libdatadog pipeline crate is missing WasmSpanState; install may be corrupt')
  }
  pipeline.init()
  const legacyStorage = storage('legacy')
  // Provide libdatadog with a `run(callback)` hook that executes the callback
  // in a noop async context, so internal HTTP/IO done by the native exporter
  // doesn't get re-instrumented by our http/fs plugins.
  pipeline.setStorage(legacyStorage.run.bind(legacyStorage, { noop: true }))
  return pipeline
}

/**
 * Helper to load a module while preventing fs instrumentation recursion.
 * During module loading, we set noop: true to prevent fs plugin from
 * triggering, which would try to create spans, which would try to load
 * this module again.
 */
function loadWithNoop (loader) {
  if (isLoading) {
    throw new Error('Recursive native module load detected')
  }
  isLoading = true
  const legacy = storage('legacy')
  const oldStore = legacy.getStore()
  legacy.enterWith({ noop: true })
  try {
    return loader()
  } finally {
    legacy.enterWith(oldStore)
    isLoading = false
  }
}

module.exports = {
  /**
   * The WasmSpanState class from the pipeline crate.
   * @type {typeof import('@datadog/libdatadog').WasmSpanState}
   */
  get WasmSpanState () {
    return getPipeline().WasmSpanState
  },

  /**
   * The OpCode enum from the pipeline crate for change buffer operations.
   * @type {object}
   */
  get OpCode () {
    if (!cachedOpCode) cachedOpCode = getPipeline().getOpCodes()
    return cachedOpCode
  },

  /**
   * Get the WASM memory for direct buffer access.
   * @type {WebAssembly.Memory}
   */
  get wasmMemory () {
    return getPipeline().getWasmMemory()
  },

  /**
   * The NativeSpansInterface class for managing native span storage.
   * @type {typeof import('./native_spans')}
   */
  get NativeSpansInterface () {
    if (!NativeSpansInterfaceModule) {
      NativeSpansInterfaceModule = loadWithNoop(() => require('./native_spans'))
    }
    return NativeSpansInterfaceModule
  },

  /**
   * The NativeDatadogSpan class for native-backed spans.
   * @type {typeof import('./span')}
   */
  get NativeDatadogSpan () {
    if (!NativeDatadogSpanModule) {
      NativeDatadogSpanModule = loadWithNoop(() => require('./span'))
    }
    return NativeDatadogSpanModule
  },
}
