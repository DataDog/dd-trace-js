'use strict'

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
    remoteConfigEnabled: config.remoteConfig.enabled
  })
})

app.post('/disable-code-origin', (req, res) => {
  tracer._tracer._config.setRemoteConfig({ code_origin_enabled: false })
  tracer._updateTracing(tracer._tracer._config)
  res.json({ success: true })
})

app.post('/enable-code-origin', (req, res) => {
  tracer._tracer._config.setRemoteConfig({ code_origin_enabled: true })
  tracer._updateTracing(tracer._tracer._config)
  res.json({ success: true })
})

const server = app.listen(process.env.APP_PORT || 0, (error) => {
  if (error) {
    throw error
  }
  process.send?.({ port: server.address().port })
})
