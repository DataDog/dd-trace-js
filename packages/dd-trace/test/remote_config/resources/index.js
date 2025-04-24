'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1
})

const express = require('express')

const app = express()
const port = process.env.APP_PORT || 3000

app.get('/', async (req, res) => {
  res.end('OK')
})

app.listen(port, () => {
  process.send({ port })
})
