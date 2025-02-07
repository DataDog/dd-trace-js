const request = require('./request')

function safeJSONStringify (value) {
  return JSON.stringify(
    value,
    (key, value) => key !== 'dd-api-key' ? value : undefined,
    process.env.DD_TRACE_BEAUTIFUL_LOGS ? 2 : undefined
  )
}

function fetchAgentInfo (url, callback) {
  request('', {
    path: '/info',
    url
  }, (err, res) => {
    if (err) {
      return callback(err)
    }
    try {
      const response = JSON.parse(res)
      return callback(null, response)
    } catch (e) {
      return callback(e)
    }
  })
}

module.exports = { safeJSONStringify, fetchAgentInfo }
