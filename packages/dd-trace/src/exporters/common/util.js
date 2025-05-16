const { getConfiguration } = require('../../config-helper')

function safeJSONStringify (value) {
  return JSON.stringify(
    value,
    (key, value) => key !== 'dd-api-key' ? value : undefined,
    getConfiguration('DD_TRACE_BEAUTIFUL_LOGS') ? 2 : undefined
  )
}

module.exports = { safeJSONStringify }
