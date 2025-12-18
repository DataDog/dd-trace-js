'use strict'

/**
 * Native spans module loader.
 *
 * Provides access to the @datadog/libdatadog pipeline crate for native span storage.
 * Falls back gracefully if the native module is unavailable.
 */

let pipeline = null
let available = false

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
    return require('./native_spans')
  },

  /**
   * The NativeSpanContext class for native-backed span contexts.
   * @type {typeof import('./span_context')}
   */
  get NativeSpanContext () {
    return require('./span_context')
  },

  /**
   * The NativeDatadogSpan class for native-backed spans.
   * @type {typeof import('./span')}
   */
  get NativeDatadogSpan () {
    return require('./span')
  }
}
