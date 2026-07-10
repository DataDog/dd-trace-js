'use strict'

const {
  API_LOGS_VERSION_RANGE,
  API_VERSION_RANGE,
  setApi,
  setApiLogs,
} = require('../../dd-trace/src/opentelemetry/api')
const { addHook } = require('./helpers/instrument')

// Expose supported runtime-loaded API copies to the holder. It resolves from the application
// entrypoint first, then uses these captures to handle custom resolution that createRequire()
// cannot reproduce. Copies outside dd-trace's supported ranges are not captured.

addHook({
  name: '@opentelemetry/api',
  versions: [API_VERSION_RANGE],
  // Do not replace the namespace with the package's reduced default export, which omits constants.
  patchDefault: false,
}, setApi)

addHook({
  name: '@opentelemetry/api-logs',
  versions: [API_LOGS_VERSION_RANGE],
  patchDefault: false,
}, setApiLogs)
