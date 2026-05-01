'use strict'

/**
 * Module-level registry that bridges the dd-trace plugin (which owns the tracer
 * and tagger refs) with the `@openai/agents-core` module load hook (which needs
 * to call `addTraceProcessor(...)` when the module loads).
 *
 * The plugin's `configure()` instantiates the integration and calls `setIntegration`.
 * The addHook reads the integration via `getIntegration` and registers the processor.
 * Either call order is safe: if the hook fires before the plugin is configured, the
 * addHook no-ops and the plugin's configure() can register the processor later
 * via the optional `onReady` callback.
 */

let currentIntegration
let onReadyListener

function setIntegration (integration) {
  currentIntegration = integration
  if (onReadyListener) {
    const cb = onReadyListener
    onReadyListener = undefined
    cb(integration)
  }
}

function getIntegration () {
  return currentIntegration
}

function clearIntegration () {
  currentIntegration = undefined
}

function onIntegrationReady (cb) {
  if (currentIntegration) {
    cb(currentIntegration)
    return
  }
  onReadyListener = cb
}

module.exports = { setIntegration, getIntegration, clearIntegration, onIntegrationReady }
