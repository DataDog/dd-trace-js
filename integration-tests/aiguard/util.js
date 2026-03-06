'use strict'

const http = require('http')

const executeRequest = (url, method = 'GET', headers = {}, body = null) => {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers,
    }, res => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const response = Buffer.concat(chunks).toString()
          // Always try to parse JSON response, regardless of status code
          let parsedBody
          try {
            parsedBody = JSON.parse(response)
          } catch {
            parsedBody = response
          }
          resolve({
            status: res.statusCode,
            body: parsedBody,
          })
        } catch (err) {
          reject(err)
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body) {
      req.write(JSON.stringify(body))
    }
    req.end()
  })
}

module.exports = { executeRequest }
