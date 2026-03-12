'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1,
})

const http = require('http')
const express = require('express')
const bodyParser = require('body-parser')

const app = express()
app.use(bodyParser.json())

app.post('/api_security_sampling/:i', (req, res) => {
  res.send('OK')
})

function collectRawBody(req, done) {
  let body = ''

  req.on('data', chunk => {
    body += chunk
  })

  req.on('end', () => {
    try {
      req.body = JSON.parse(body || '{}')
    } catch {
      req.body = {}
    }

    done()
  })
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api_security_sampling_resource_renaming')) {
    collectRawBody(req, () => {
      res.writeHead(200)
      res.end('OK')
    })
    return
  }

  app(req, res)
})

server.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})
