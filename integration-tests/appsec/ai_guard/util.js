'use strict'

const http = require('http')

const executeRequest = (url, method = 'GET', headers = {}, body = null) => {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers
    }, res => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const response = Buffer.concat(chunks).toString()
          resolve({
            status: res.statusCode,
            body: res.statusCode === 200 ? JSON.parse(response) : response
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
