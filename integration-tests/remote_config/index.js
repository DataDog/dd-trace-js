'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1
})

const express = require('express')

const app = express()

app.get('/', async (req, res) => {
  res.end('OK')
})

const server = app.listen(process.env.APP_PORT || 0, (error) => {
  if (error) {
    throw error
  }
  process.send?.({ port: server.address().port })
})
