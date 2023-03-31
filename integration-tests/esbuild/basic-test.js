#!/usr/bin/env node

const tracer = require('../../').init() // dd-trace

const assert = require('assert')
const express = require('express')
const http = require('http')

const app = express()
const PORT = 31415

assert.equal(express.static.mime.types.ogg, 'audio/ogg')

const server = app.listen(PORT, () => {
  setImmediate(() => {
    http.request(`http://localhost:${PORT}`).end() // query to self
  })
})

app.get('/', async (_req, res) => {
  assert.equal(
    tracer.scope().active().context()._tags.component,
    'express',
    'the sample app bundled by esbuild is not properly instrumented'
  ) // bad exit

  res.json({ narwhal: 'bacons' })

  setImmediate(() => {
    server.close() // clean exit
    setImmediate(() => {
      process.exit(0)
    })
  })
})
