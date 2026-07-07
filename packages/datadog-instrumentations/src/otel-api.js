'use strict'

const otelApi = require('../../dd-trace/src/opentelemetry/api')
const { addHook } = require('./helpers/instrument')

// Capture the application's own copy of the OpenTelemetry API packages as it is required,
// so the bridge registers its providers on the exact copy the application reads with. The
// OTel global API rejects a provider registered by a copy older than the reader's, which
// silently downgrades every span to a no-op (issue #6882); binding to the application's copy
// removes the mismatch. The version ranges match dd-trace's declared support — a copy outside
// the range is left uncaptured, so the bridge falls back to dd-trace's own bundled copy rather
// than binding to an unsupported version.

/**
 * @param {string} packageName
 * @returns {(moduleExports: object) => object}
 */
function capture (packageName) {
  return (moduleExports) => {
    otelApi.setApi(packageName, moduleExports)
    return moduleExports
  }
}

addHook({
  name: otelApi.API,
  versions: ['>=1.0.0 <1.10.0'],
}, capture(otelApi.API))

addHook({
  name: otelApi.API_LOGS,
  versions: ['>=0.33.0 <1.0.0'],
}, capture(otelApi.API_LOGS))
