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

downstreamApp.get('/api/form', (_, res) => {
  res.setHeader('echo-headers', 'qwoierj12l3')
  res.type('application/x-www-form-urlencoded')
  res.send('payload_out=kqehf09123r4lnksef')
})

downstreamApp.get('/api/text', (_, res) => {
  res.setHeader('echo-headers', 'qwoierj12l3')
  res.type('text/plain')
  res.send('plain-text-body')
})

let downstreamPort

// Main app routes
app.post('/with-body', (_, res) => {
  http.get(`http://localhost:${downstreamPort}/api/data`,
    {
      headers: {
        Witness: 'pwq3ojtropiw3hjtowir'
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

app.post('/with-body-form', (_, res) => {
  http.get(`http://localhost:${downstreamPort}/api/form`,
    {
      headers: {
        Witness: 'pwq3ojtropiw3hjtowir'
      }
    },
    downstreamRes => {
      downstreamRes.setEncoding('utf8')
      let body = ''

      downstreamRes.on('data', chunk => {
        body += chunk
      })

      downstreamRes.on('end', () => {
        res.json({ consumed: true, downstream: body, via: 'form' })
      })
    })
})

app.post('/with-body-text', (_, res) => {
  http.get(`http://localhost:${downstreamPort}/api/text`,
    {
      headers: {
        Witness: 'pwq3ojtropiw3hjtowir'
      }
    },
    downstreamRes => {
      downstreamRes.setEncoding('utf8')
      let body = ''

      downstreamRes.on('data', chunk => {
        body += chunk
      })

      downstreamRes.on('end', () => {
        res.json({ consumed: true, downstream: body, via: 'text' })
      })
    })
})

app.post('/with-readable', (_, res) => {
  http.get(`http://localhost:${downstreamPort}/api/data`,
    {
      headers: {
        Witness: 'pwq3ojtropiw3hjtowir'
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

// async iterator is using req.read() internally
app.post('/with-async-iterator', (_, res) => {
  http.get(`http://localhost:${downstreamPort}/api/data`,
    {
      headers: {
        Witness: 'pwq3ojtropiw3hjtowir'
      }
    },
    downstreamRes => {
      downstreamRes.setEncoding('utf8')

      ; (async () => {
        for await (const chunk of downstreamRes) { // eslint-disable-line no-unused-vars
          // just consume
        }
      })().then(() => {
        res.json({ consumed: true })
      }).catch(err => {
        res.status(500).json({ error: err.message })
      })
    })
})

app.post('/without-body-and-headers', (_, res) => {
  http.get(`http://localhost:${downstreamPort}/api/data`, () => {
    // Don't consume body
    res.json({ consumed: false })
  })
})

const downstreamServer = downstreamApp.listen(0, () => {
  downstreamPort = downstreamServer.address().port

  const mainServer = app.listen(0, () => {
    const port = mainServer.address().port
    process.send({ port })
  })
})
