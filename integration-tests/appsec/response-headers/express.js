'use strict'

const tracer = require('dd-trace')
tracer.init({ flushInterval: 0 })

const express = require('express')

const app = express()

app.get('/', (req, res) => {
  res.type('text/plain').send('hello')
})

const server = app.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})
