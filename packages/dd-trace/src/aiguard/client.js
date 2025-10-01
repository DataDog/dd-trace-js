'use strict'

async function executeRequest (body, opts) {
  const postData = JSON.stringify(body)
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
    ...opts.headers
  }

  const response = await fetch(opts.url, {
    method: 'POST',
    headers,
    body: postData,
    signal: AbortSignal.timeout(opts.timeout)
  })

  const responseBody = await response.json()
  return {
    status: response.status,
    body: responseBody
  }
}

module.exports = executeRequest
