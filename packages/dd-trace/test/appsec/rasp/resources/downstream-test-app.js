'use strict'

require('dd-trace').init({
  flushInterval: 0
})

const http = require('http')
const express = require('express')

const app = express()

// Mock downstream server that always returns JSON + headers
const downstreamApp = express()
downstreamApp.get('/api/data', (_, res) => {
  res.setHeader('echo-headers', 'qwoierj12l3')
  res.json({ payload_out: 'kqehf09123r4lnksef' })
})

let downstreamServer
let downstreamPort

// Main app routes
app.post('/with-body', (_, res) => {
  http.get(`http://localhost:${downstreamPort}/api/data`,
    {
      headers: {
        'Witness': 'pwq3ojtropiw3hjtowir'
      }
    },
    downstreamRes => {
      downstreamRes.setEncoding('utf8')
      let body = ''

      downstreamRes.on('data', chunk => {
        body += chunk
      })

      downstreamRes.on('end', () => {
        res.json({ consumed: true, downstream: body })
      })
    })
})

app.post('/with-readable', (_, res) => {
  http.get(`http://localhost:${downstreamPort}/api/data`,
    {
      headers: {
        'Witness': 'pwq3ojtropiw3hjtowir'
      }
    },
    downstreamRes => {
      downstreamRes.setEncoding('utf8')
      let body = ''

      const consume = () => {
        let chunk
        while ((chunk = downstreamRes.read()) !== null) {
          body += chunk
        }
      }

      downstreamRes.on('readable', consume)
      downstreamRes.on('end', () => {
        res.json({ consumed: true, downstream: body, via: 'readable' })
      })
    })
})

app.post('/without-body-and-headers', (_, res) => {
  http.get(`http://localhost:${downstreamPort}/api/data`, () => {
    // Don't consume body
    res.json({ consumed: false })
  })
})

downstreamServer = downstreamApp.listen(0, () => {
  downstreamPort = downstreamServer.address().port

  const mainServer = app.listen(0, () => {
    const port = mainServer.address().port
    process.send({ port })
  })
})
