'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1
})
const express = require('express')

const app = express()
const port = process.env.APP_PORT || 3000

app.get('/eval', async (req, res) => {
  require('./eval-methods').runEval(req.query.code, 'test-result')

  res.end('OK')
})

app.listen(port, () => {
  process.send({ port })
})
