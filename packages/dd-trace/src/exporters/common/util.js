'use strict'

const { getValueFromEnvSources } = require('../../config/helper')

function safeJSONStringify (value) {
  return JSON.stringify(
    value,
    (key, value) => key === 'dd-api-key' ? undefined : value,
    getValueFromEnvSources('DD_TRACE_BEAUTIFUL_LOGS') ? 2 : undefined
  )
}

module.exports = { safeJSONStringify }
