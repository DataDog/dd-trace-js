'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1
})
const express = require('express')

const app = express()

app.get('/eval', async (req, res) => {
  require('./eval-methods').runEval(req.query.code, 'test-result')

  res.end('OK')
})

const server = app.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})
