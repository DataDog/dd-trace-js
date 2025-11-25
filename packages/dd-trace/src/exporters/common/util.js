'use strict'

const { getResolvedEnv } = require('../../config-env-sources')

function safeJSONStringify (value) {
  return JSON.stringify(
    value,
    (key, value) => key === 'dd-api-key' ? undefined : value,
    getResolvedEnv('DD_TRACE_BEAUTIFUL_LOGS') ? 2 : undefined
  )
}

module.exports = { safeJSONStringify }
