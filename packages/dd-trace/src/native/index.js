'use strict'

/**
 * Libdatadog pipeline module loader.
 *
 * Loading is deferred until the native exporter is selected so package managers
 * can omit the optional dependency in constrained installs. Loader failures are
 * surfaced to the caller, which distinguishes an omitted dependency from corruption.
 */

const { storage } = require('../../../datadog-core')

// Cached module references to avoid repeated require() calls
// which can cause infinite recursion if fs plugin is active during require
let NativeSpansInterfaceModule = null

// Flag to track if we're currently loading a module to prevent recursion
let isLoading = false

let pipeline = null

const CONTAINER_TAGS_HASH_HEADER = 'datadog-container-tags-hash'

/**
 * Pull `Datadog-Container-Tags-Hash` out of an agent response and hand it to the
 * propagation hash, mirroring `exporters/agent/writer.js`.
 *
 * libdatadog's transport passes Node's `res.rawHeaders`: a flat
 * `[name, value, name, value, ...]` array that preserves the sender's casing and
 * repeats a header as another pair. Walk the name slots and take the first
 * match. The transport wraps this call in its own try/catch, but there is
 * nothing here that can throw on a well-formed array.
 *
 * @param {unknown} rawHeaders
 */
function observeResponseHeaders (rawHeaders) {
  if (!Array.isArray(rawHeaders)) return
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() !== CONTAINER_TAGS_HASH_HEADER) continue
    const hash = rawHeaders[i + 1]
    if (hash) require('../propagation-hash').updateContainerTagsHash(hash)
    return
  }
}

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
  // The agent returns `Datadog-Container-Tags-Hash` whenever the request carried
  // a container id. The legacy writer feeds it to the propagation hash so DBM SQL
  // comments and DSM pathway hashes correlate with container tags; without this
  // the libdatadog transport keeps hashing process tags alone. Registered on the module
  // (not the state), so it survives the `setAgentUrl` state rebuild.
  pipeline.setResponseHeaderObserver(observeResponseHeaders)
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
   * The NativeSpansInterface class for managing libdatadog export state.
   * @type {typeof import('./native-spans')}
   */
  get NativeSpansInterface () {
    if (!NativeSpansInterfaceModule) {
      NativeSpansInterfaceModule = loadWithNoop(() => require('./native-spans'))
    }
    return NativeSpansInterfaceModule
  },
}
