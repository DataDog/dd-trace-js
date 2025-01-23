'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1
})

const express = require('express')
const vm = require('node:vm')

const app = express()
const port = process.env.APP_PORT || 3000

app.get('/vm/SourceTextModule', async (req, res) => {
  const module = new vm.SourceTextModule(req.query.script)
  await module.link(() => {})
  await module.evaluate()

  res.end('OK')
})

app.listen(port, () => {
  process.send({ port })
})
