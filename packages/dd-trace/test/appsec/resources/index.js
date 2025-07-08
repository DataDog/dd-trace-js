'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1
})

const express = require('express')
const body = require('body-parser')

const app = express()
app.use(body.json())

app.post('/', async (req, res) => {
  res.end('OK')
})

const server = app.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})
