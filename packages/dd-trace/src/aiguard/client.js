'use strict'

const http = require('http')
const https = require('https')
const { URL } = require('url')

function executeRequest (body, opts) {
  return new Promise((resolve, reject) => {
    let parsedUrl
    try {
      parsedUrl = new URL(opts.url)
    } catch {
      return reject(new Error(`Invalid URL: ${opts.url}`))
    }
    const transport = parsedUrl.protocol === 'https:' ? https : http
    const postData = JSON.stringify(body)
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...opts.headers
      },
      timeout: opts.timeout,
    }
    const req = transport.request(options, res => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const rawBody = Buffer.concat(chunks)
          resolve({
            status: res.statusCode,
            body: JSON.parse(rawBody.toString()),
          })
        } catch (e) {
          reject(e)
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', req.abort)
    req.write(postData)
    req.end()
  })
}

module.exports = executeRequest
