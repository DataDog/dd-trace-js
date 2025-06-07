'use strict'
const tracer = require('dd-trace')
tracer.init({
  flushInterval: 0
})

const express = require('express')

const app = express()

app.get('/', (req, res) => {
  // Content headers
  res.set('content-type', 'text/plain')
  res.set('content-language', 'en')

  // Custom headers
  for (let i = 0; i < 25; i++) {
    res.set(`x-datadog-res-${i}`, `ext-res-${i}`)
  }

  res.end('end')
})

const server = app.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})
