'use strict'

// Holder for the OpenTelemetry API packages the bridge registers its providers on.
//
// The bridge must register on the exact copy the application reads with: the OTel global API
// rejects a provider registered by a copy older than the reader's and silently downgrades every
// span to a no-op (issue #6882). The `@opentelemetry/api` instrumentation captures the
// application's own copy the moment it is required and hands it here via `setApi`, so when the
// application uses OpenTelemetry we register on its copy and the version mismatch disappears.
//
// When the application does not depend on `@opentelemetry/api` itself we fall back to the copy
// bundled with dd-trace. Nothing else reads OTel in that case, so there is no second copy for the
// bundled one to clash with, which keeps the bridge and the OTLP metrics/logs pipelines working
// without forcing every user to add the packages to their own dependencies.

/** @typedef {typeof import('@opentelemetry/api')} OtelApi */
/** @typedef {typeof import('@opentelemetry/api-logs')} OtelApiLogs */

const API = '@opentelemetry/api'
const API_LOGS = '@opentelemetry/api-logs'

/** @type {Map<string, object>} */
const captured = new Map()

/**
 * Records the application's copy of an OpenTelemetry API package. Called by the instrumentation
 * when the application requires the package. The first copy wins so a second library loading its
 * own copy cannot steal the binding.
 *
 * @param {string} packageName
 * @param {object} api - The package's module exports, captured from the application's require.
 */
function setApi (packageName, api) {
  if (captured.has(packageName)) return
  captured.set(packageName, api)
}

/**
 * The application's `@opentelemetry/api` when it has been captured, otherwise the copy bundled
 * with dd-trace.
 *
 * @returns {OtelApi}
 */
function getApi () {
  return /** @type {OtelApi} */ (captured.get(API) ?? require('@opentelemetry/api'))
}

/**
 * @returns {OtelApiLogs}
 */
function getApiLogs () {
  return /** @type {OtelApiLogs} */ (captured.get(API_LOGS) ?? require('@opentelemetry/api-logs'))
}

module.exports = { API, API_LOGS, setApi, getApi, getApiLogs }
