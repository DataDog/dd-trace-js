'use strict'

// @ts-expect-error This code is running in a sandbox where dd-trace is available
const tracer = require('dd-trace')

tracer.init({ flushInterval: 1 })

const express = require('express')
const app = express()

app.get('/hello', (req, res) => {
  res.json({ message: 'Hello World' })
})

app.get('/config', (req, res) => {
  const config = tracer._tracer._config
  res.json({
    codeOriginEnabled: config.codeOriginForSpans.enabled,
    remoteConfigEnabled: config.remoteConfig.enabled,
  })
})

const server = app.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: (/** @type {import('net').AddressInfo} */ (server.address())).port })
})
