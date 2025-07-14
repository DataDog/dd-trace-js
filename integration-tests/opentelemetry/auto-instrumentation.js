'use strict'

const tracer = require('dd-trace').init()
const { TracerProvider } = tracer
const provider = new TracerProvider()
provider.register()

const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express')

registerInstrumentations({
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook (req) {
        // Ignore spans from static assets.
        return req.path === '/v0.4/traces' || req.path === '/v0.7/config' ||
        req.path === '/telemetry/proxy/api/v2/apmtelemetry'
      },
      ignoreOutgoingRequestHook (req) {
        // Ignore spans from static assets.
        return req.path === '/v0.4/traces' || req.path === '/v0.7/config' ||
        req.path === '/telemetry/proxy/api/v2/apmtelemetry'
      }
    }),
    new ExpressInstrumentation()
  ],
  tracerProvider: provider
})

const express = require('express')
const http = require('http')
const app = express()
const PORT = process.env.SERVER_PORT

app.get('/second-endpoint', (req, res) => {
  res.send('Response from second endpoint')
  server.close(() => {
  })
})

app.get('/first-endpoint', async (req, res) => {
  try {
    const response = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT}/second-endpoint`).on('finish', (response) => {
        resolve(response)
      }).on('error', (error) => {
        reject(error)
      })
    })
    res.send(`First endpoint received: ${response}`)
  } catch (error) {
    res.status(500).send(`Error occurred while making nested call ${error}`)
  }
})

const server = app.listen(PORT, () => {})
