'use strict'

const tracer = require('dd-trace')

tracer.init({ flushInterval: 1 })

const fastify = require('fastify')
const app = fastify()

// Fastify requires explicit content-type parser for POST
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    const json = JSON.parse(body)
    done(null, json)
  } catch (err) {
    done(err)
  }
})

app.get('/hello', (req, res) => {
  res.send({ message: 'Hello World' })
})

app.get('/config', (req, res) => {
  const config = tracer._tracer._config
  res.send({
    codeOriginEnabled: config.codeOriginForSpans.enabled,
    remoteConfigEnabled: config.remoteConfig.enabled
  })
})

app.post('/disable-code-origin', (req, res) => {
  tracer._tracer._config.setRemoteConfig({ code_origin_enabled: false })
  tracer._updateTracing(tracer._tracer._config)
  res.send({ success: true })
})

app.post('/enable-code-origin', (req, res) => {
  tracer._tracer._config.setRemoteConfig({ code_origin_enabled: true })
  tracer._updateTracing(tracer._tracer._config)
  res.send({ success: true })
})

app.listen({ port: process.env.APP_PORT || 0 }, (error) => {
  if (error) {
    throw error
  }
  process.send?.({ port: app.server.address().port })
})
