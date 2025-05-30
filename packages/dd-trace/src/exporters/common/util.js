function safeJSONStringify (value) {
  return JSON.stringify(
    value,
    (key, value) => key === 'dd-api-key' ? undefined : value,
    process.env.DD_TRACE_BEAUTIFUL_LOGS ? 2 : undefined
  )
}

module.exports = { safeJSONStringify }
