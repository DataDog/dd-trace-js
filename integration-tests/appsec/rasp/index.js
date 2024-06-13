'use strict'

require('dd-trace').init()

const path = require('path')
const fs = require('fs')

const http = require('https')
const express = require('express')

const app = express()
const port = process.env.APP_PORT || 3000

app.get('/ping', (req, res) => {
  res.end('pong')
})

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
    res.appendHeader('key2', 'value2')
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
    res.writeEarlyHints({
      link: earlyHintsLink
    })
    res.end()
  })
})

function streamFile (res) {
  const stream = fs.createReadStream(path.join(__dirname, 'streamtest.txt'), { encoding: 'utf8' })
  stream.pipe(res, { end: false })
  stream.on('end', () => res.end('end'))
}

app.listen(port, () => {
  process.send({ port })
})
