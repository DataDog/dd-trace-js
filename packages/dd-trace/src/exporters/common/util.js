function safeJSONStringify (value) {
  return JSON.stringify(
    value,
    (key, value) => key !== 'dd-api-key' ? value : undefined,
    process.env.DD_TRACE_BEAUTIFUL_LOGS ? 2 : undefined
  )
}

module.exports = { safeJSONStringify }
