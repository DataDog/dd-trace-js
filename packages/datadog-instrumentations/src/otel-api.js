'use strict'

const {
  API_LOGS_VERSION_RANGE,
  API_VERSION_RANGE,
  setApi,
  setApiLogs,
} = require('../../dd-trace/src/opentelemetry/api')
const { addHook } = require('./helpers/instrument')

addHook({
  name: '@opentelemetry/api',
  versions: [API_VERSION_RANGE],
  // The default export omits constants used by the bridge.
  patchDefault: false,
}, setApi)

addHook({
  name: '@opentelemetry/api-logs',
  versions: [API_LOGS_VERSION_RANGE],
  patchDefault: false,
}, setApiLogs)
