'use strict'

async function executeRequest (body, opts) {
  const postData = JSON.stringify(body)
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
    ...opts.headers
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), opts.timeout)

  try {
    const response = await fetch(opts.url, {
      method: 'POST',
      headers,
      body: postData,
      signal: controller.signal
    })

    clearTimeout(timeoutId)

    const responseBody = await response.json()
    return {
      status: response.status,
      body: responseBody
    }
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
}

module.exports = executeRequest
