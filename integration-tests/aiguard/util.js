'use strict'

const http = require('http')

const executeRequest = (url, headers = {}) => {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'GET',
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
    req.end()
  })
}

module.exports = { executeRequest }
