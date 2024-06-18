'use strict'

const options = {
  appsec: {
    enabled: true
  },
  experimental: {
    iast: {
      enabled: true,
      requestSampling: 100
    },
    appsec: {
      standalone: {
        enabled: false
      }
    }
  }
}

if (process.env.AGENT_PORT) {
  options.port = process.env.AGENT_PORT
}

if (process.env.AGENT_URL) {
  options.url = process.env.AGENT_URL
}

if (process.env.DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED) {
  options.experimental.appsec.standalone.enabled = process.env.DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED === 'true'
}

const tracer = require('dd-trace')
tracer.init(options)

const http = require('http')
const express = require('express')
const app = express()

const { readFile } = require('./readFile')

app.get('/', (req, res) => {
  res.status(200).send('hello world')
})

app.get('/login', (req, res) => {
  tracer.appsec.trackUserLoginSuccessEvent({ id: req.query.user })
  res.status(200).send('login')
})

app.get('/sdk', (req, res) => {
  tracer.appsec.trackCustomEvent('custom-event')
  res.status(200).send('sdk')
})

app.get('/vulnerableReadFile', (req, res) => {
  res.status(200).send(readFile(req.query.filename))
})

app.get('/propagation-with-event', async (req, res) => {
  tracer.appsec.trackCustomEvent('custom-event')

  const port = server.address().port
  const url = `http://localhost:${port}/down`

  const resFetch = await fetch(url, {
    headers: {
      'x-datadog-tags': '_dd.p.other=1'
    }
  })
  await resFetch.text()

  res.status(200).send('propagation-with-event')
})

app.get('/propagation-without-event', async (req, res) => {
  const port = server.address().port
  const url = `http://localhost:${port}/down`

  const resFetch = await fetch(url, {
    headers: {
      'x-datadog-tags': '_dd.p.other=1'
    }
  })
  await resFetch.text()

  res.status(200).send('propagation-without-event')
})

app.get('/down', async (req, res) => {
  res.status(200).send('down')
})

const server = http.createServer(app).listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
