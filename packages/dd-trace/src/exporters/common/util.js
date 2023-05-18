function safeJSONStringify (value) {
  return JSON.stringify(
    value,
    (key, value) => key !== 'dd-api-key' ? value : undefined,
    2
  )
}

module.exports = { safeJSONStringify }
