'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 0
})

const express = require('express')
const { readFileSync } = require('fs')

const app = express()
const port = process.env.APP_PORT || 3000

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

app.listen(port, () => {
  process.send({ port })
})
