'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 0
})

const express = require('express')
const { readFileSync } = require('fs')

const app = express()

app.get('/lfi/sync', (req, res) => {
  let result
  try {
    result = readFileSync(req.query.file)
  } catch (e) {
    if (e.message === 'DatadogRaspAbortError') {
      throw e
    }
  }
  res.send(result)
})

const server = app.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})
