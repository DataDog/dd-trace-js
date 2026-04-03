'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1,
})

const vm = require('node:vm')
const express = require('express')

const app = express()

app.get('/vm/SourceTextModule', async (req, res) => {
  const module = new vm.SourceTextModule(req.query.script)
  await module.link(() => {})
  await module.evaluate()

  res.end('OK')
})

const server = app.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: (/** @type {import('net').AddressInfo} */ (server.address())).port })
})
