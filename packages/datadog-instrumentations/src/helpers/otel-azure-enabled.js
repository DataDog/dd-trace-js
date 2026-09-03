'use strict'

const { getValueFromEnvSources } = require('../../../dd-trace/src/config/helper')

function isOtelSdkEnabled () {
  const ddTraceOtelEnabled = getValueFromEnvSources('DD_TRACE_OTEL_ENABLED', true)
  if (ddTraceOtelEnabled === false) return false
  const otelSdkDisabled = getValueFromEnvSources('OTEL_SDK_DISABLED', true)
  if (otelSdkDisabled) return false
  return ddTraceOtelEnabled || otelSdkDisabled === false
}

// OTel-only Azure/Durable auto-instrumentation replaces the native
// azure-durable-functions plugin (plugins: false + DD_TRACE_AZURE_DURABLE_FUNCTIONS_ENABLED=false).
function isOtelAzureInstrumentationEnabled () {
  if (!isOtelSdkEnabled()) return false

  const nativeDurableEnabled = getValueFromEnvSources('DD_TRACE_AZURE_DURABLE_FUNCTIONS_ENABLED', true)
  return nativeDurableEnabled === false
}

module.exports = {
  isOtelSdkEnabled,
  isOtelAzureInstrumentationEnabled,
}
