'use strict'

const options = {
  appsec: {
    enabled: true
  },
  experimental: {
    iast: {
      enabled: true,
      requestSampling: 100
    }
  }
}

if (process.env.AGENT_PORT) {
  options.port = process.env.AGENT_PORT
}

if (process.env.AGENT_URL) {
  options.url = process.env.AGENT_URL
}

const tracer = require('dd-trace')
tracer.init(options)

const http = require('http')
const express = require('express')
const app = express()

const valueToHash = 'iast-showcase-demo'
const crypto = require('crypto')

async function makeRequest (url) {
  return new Promise((resolve, reject) => {
    http.get(url, function (res) {
      const chunks = []

      res.on('data', function (chunk) {
        chunks.push(chunk)
      })

      res.on('end', () => {
        resolve( Buffer.concat(chunks).toString('utf8'))
      })

      res.on('error', reject)
    })
  })
}

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

app.get('/vulnerableHash', (req, res) => {
  const result = crypto.createHash('sha1').update(valueToHash).digest('hex')
  res.status(200).send(result)
})

app.get('/propagation-with-event', async (req, res) => {
  tracer.appsec.trackCustomEvent('custom-event')

  const span = tracer.scope().active()
  span.context()._trace.tags['_dd.p.other'] = '1'

  const port = req.query.port || server.address().port
  const url = `http://localhost:${port}/down`

  await makeRequest(url)

  res.status(200).send('propagation-with-event')
})

app.get('/propagation-without-event', async (req, res) => {
  const port = req.query.port || server.address().port
  const url = `http://localhost:${port}/down`

  const span = tracer.scope().active()
  span.context()._trace.tags['_dd.p.other'] = '1'

  await makeRequest(url)

  res.status(200).send('propagation-without-event')
})

app.get('/down', (req, res) => {
  res.status(200).send('down')
})

app.get('/propagation-after-drop-and-call-sdk', async (req, res) => {
  const span = tracer.scope().active()
  span?.setTag('manual.drop', 'true')

  const port = req.query.port

  const url = `http://localhost:${port}/sdk`

  const sdkRes = await makeRequest(url)


  res.status(200).send(`drop-and-call-sdk ${sdkRes}`)
})

const server = http.createServer(app).listen(0, () => {
  const port = server.address().port
  process.send?.({ port })
})
