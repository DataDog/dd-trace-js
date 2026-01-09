'use strict'

/**
 * Native spans module loader.
 *
 * Provides access to the @datadog/libdatadog pipeline crate for native span storage.
 * Falls back gracefully if the native module is unavailable.
 */

const { storage } = require('../../../datadog-core')

let pipeline = null
let available = false

// Cached module references to avoid repeated require() calls
// which can cause infinite recursion if fs plugin is active during require
let NativeSpansInterfaceModule = null
let NativeSpanContextModule = null
let NativeDatadogSpanModule = null

// Flag to track if we're currently loading a module to prevent recursion
let isLoading = false

try {
  const libdatadog = require('@datadog/libdatadog')
  // Use maybeLoad to avoid throwing if the pipeline crate is not available
  pipeline = libdatadog.maybeLoad('pipeline')
  // Only mark as available if NativeSpanState is actually present
  available = pipeline?.NativeSpanState != null
} catch (e) {
  // Native module not available - this is expected on some platforms
  available = false
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
   * Whether the native pipeline module is available.
   * @type {boolean}
   */
  get available () {
    return available
  },

  /**
   * The NativeSpanState class from the pipeline crate.
   * @type {typeof import('@datadog/libdatadog').NativeSpanState | null}
   */
  get NativeSpanState () {
    return pipeline?.NativeSpanState ?? null
  },

  /**
   * The OpCode enum from the pipeline crate for change buffer operations.
   * @type {typeof import('@datadog/libdatadog').OpCode | null}
   */
  get OpCode () {
    return pipeline?.OpCode ?? null
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
   * The NativeSpanContext class for native-backed span contexts.
   * @type {typeof import('./span_context')}
   */
  get NativeSpanContext () {
    if (!NativeSpanContextModule) {
      NativeSpanContextModule = loadWithNoop(() => require('./span_context'))
    }
    return NativeSpanContextModule
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
  }
}
