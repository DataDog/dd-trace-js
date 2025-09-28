'use strict'

async function executeRequest (body, opts) {
  const postData = JSON.stringify(body)
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
    ...opts.headers
  }

  const controller = new AbortController()
  const timeoutId = opts.timeout ? setTimeout(() => controller.abort(), opts.timeout) : null

  try {
    const response = await fetch(opts.url, {
      method: 'POST',
      headers,
      body: postData,
      signal: controller.signal
    })

    if (timeoutId) clearTimeout(timeoutId)

    const responseBody = await response.json()
    return {
      status: response.status,
      body: responseBody
    }
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId)
    throw error
  }
}

module.exports = executeRequest
