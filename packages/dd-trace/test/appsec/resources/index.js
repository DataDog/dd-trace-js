'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1
})

const express = require('express')
const body = require('body-parser')

const app = express()
app.use(body.json())
const port = process.env.APP_PORT || 3000

app.post('/', async (req, res) => {
  res.end('OK')
})

app.listen(port, () => {
  process.send({ port })
})
