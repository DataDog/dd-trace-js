'use strict'
const tracer = require('dd-trace')
tracer.init({
  flushInterval: 0
})

const path = require('path')
const fs = require('fs')
const http = require('https')
const express = require('express')
const axios = require('axios')

const app = express()
const port = process.env.APP_PORT || 3000

function makeOutgoingRequestAndCbAfterTimeout (req, res, cb) {
  let finished = false
  setTimeout(() => {
    if (!finished && cb) {
      cb()
    }
  }, 10)

  http.get(`https://${req.query.host}`, () => {
    finished = true
    res.send('end')
  })
}

function streamFile (res) {
  const stream = fs.createReadStream(path.join(__dirname, 'streamtest.txt'), { encoding: 'utf8' })
  stream.pipe(res, { end: false })
  stream.on('end', () => res.end('end'))
}

function httpGetPromise (host) {
  return new Promise((resolve, reject) => {
    const clientRequest = http.get(`https://${host}`, () => {
      resolve()
    })
    clientRequest.on('error', reject)
  })
}

app.use(express.json())

app.get('/crash', () => {
  process.nextTick(() => {
    throw new Error('Crash')
  })
})

app.get('/crash-and-recovery-A', (req, res) => {
  process.setUncaughtExceptionCaptureCallback(() => {
    res.writeHead(500)
    res.end('error')

    process.setUncaughtExceptionCaptureCallback(null)
  })

  process.nextTick(() => {
    throw new Error('Crash')
  })
})

app.get('/crash-and-recovery-B', (req, res) => {
  function exceptionHandler () {
    res.writeHead(500)
    res.end('error')

    process.off('uncaughtException', exceptionHandler)
  }

  process.on('uncaughtException', exceptionHandler)

  process.nextTick(() => {
    throw new Error('Crash')
  })
})

app.get('/ssrf/http/manual-blocking', (req, res) => {
  const clientRequest = http.get(`https://${req.query.host}`, () => {
    res.send('end')
  })

  clientRequest.on('error', (err) => {
    if (err.name === 'DatadogRaspAbortError') {
      res.writeHead(418)
      res.end('aborted')
    } else {
      res.writeHead(500)
      res.end('error')
    }
  })
})

app.get('/ssrf/http/custom-uncaught-exception-capture-callback', (req, res) => {
  process.setUncaughtExceptionCaptureCallback(() => {
    // wanted a log to force error on tests
    // eslint-disable-next-line no-console
    console.log('Custom uncaught exception capture callback')
    res.writeHead(500)
    res.end('error')
  })

  http.get(`https://${req.query.host}`, () => {
    res.send('end')
  })
})

app.get('/ssrf/http/should-block-in-domain', (req, res) => {
  // eslint-disable-next-line n/no-deprecated-api
  const d = require('node:domain').create()
  d.run(() => {
    http.get(`https://${req.query.host}`, () => {
      res.send('end')
    })
  })
})

app.get('/ssrf/http/custom-uncaughtException-listener', (req, res) => {
  process.on('uncaughtException', () => {
    // wanted a log to force error on tests
    // eslint-disable-next-line no-console
    console.log('Custom uncaught exception capture callback')
    res.writeHead(500)
    res.end('error')
  })

  http.get(`https://${req.query.host}`, () => {
    res.send('end')
  })
})

app.get('/ssrf/http/unhandled-error', (req, res) => {
  makeOutgoingRequestAndCbAfterTimeout(req, res)
})

app.get('/ssrf/http/unhandled-async-write-A', (req, res) => {
  makeOutgoingRequestAndCbAfterTimeout(req, res, () => {
    res.send('Late end')
  })
})

app.get('/ssrf/http/unhandled-async-write-B', (req, res) => {
  makeOutgoingRequestAndCbAfterTimeout(req, res, () => {
    streamFile(res)
  })
})

app.get('/ssrf/http/unhandled-async-write-C', (req, res) => {
  makeOutgoingRequestAndCbAfterTimeout(req, res, () => {
    res.setHeader('key', 'value')
    res.writeHead(200, 'OK', ['key2', 'value2'])
    res.write('test\n')
    res.end('end')
  })
})

app.get('/ssrf/http/unhandled-async-write-D', (req, res) => {
  makeOutgoingRequestAndCbAfterTimeout(req, res, () => {
    res.setHeader('key', 'value')
    res.appendHeader?.('key2', 'value2')
    res.removeHeader('key')
    res.flushHeaders()
    res.end('end')
  })
})

app.get('/ssrf/http/unhandled-async-write-E', (req, res) => {
  makeOutgoingRequestAndCbAfterTimeout(req, res, () => {
    res.writeContinue()
    res.end()
  })
})

app.get('/ssrf/http/unhandled-async-write-F', (req, res) => {
  makeOutgoingRequestAndCbAfterTimeout(req, res, () => {
    res.writeProcessing()
    res.end()
  })
})

app.get('/ssrf/http/unhandled-async-write-G', (req, res) => {
  makeOutgoingRequestAndCbAfterTimeout(req, res, () => {
    const earlyHintsLink = '</styles.css>; rel=preload; as=style'
    res.writeEarlyHints?.({
      link: earlyHintsLink
    })
    res.end()
  })
})

app.get('/ssrf/http/unhandled-async-write-H', (req, res) => {
  makeOutgoingRequestAndCbAfterTimeout(req, res, () => {
    res.json({ key: 'value' })
  })
})

app.get('/ssrf/http/unhandled-axios', (req, res) => {
  axios.get(`https://${req.query.host}`)
    .then(() => res.end('end'))
})

app.get('/ssrf/http/unhandled-promise', (req, res) => {
  httpGetPromise(req.query.host)
    .then(() => res.end('end'))
})

app.post('/ssrf', (req, res) => {
  axios.get(`https://${req.body.host}`)
    .then(() => res.end('end'))
})

app.listen(port, () => {
  process.send({ port })
})
