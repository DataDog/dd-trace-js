'use strict'

const getConfig = require('../../config')

function safeJSONStringify (value) {
  return JSON.stringify(
    value,
    (key, value) => key === 'dd-api-key' ? undefined : value,
    getConfig().DD_TRACE_BEAUTIFUL_LOGS ? 2 : undefined
  )
}

module.exports = { safeJSONStringify }
