'use strict'

const options = {
  appsec: {
    enabled: true
  },
  iast: {
    enabled: true,
    requestSampling: 100
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
const childProcess = require('child_process')

const multer = require('multer')
const uploadToMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200000 } })

const app = express()

app.post('/', uploadToMemory.single('file'), (req, res) => {
  res.end('DONE')
})

app.post('/no-middleware', (req, res) => {
  uploadToMemory.none()(req, res, () => {
    res.end('DONE')
  })
})

app.post('/cmd', uploadToMemory.single('file'), (req, res) => {
  childProcess.exec(req.body.command, () => {
    res.end('DONE')
  })
})

app.post('/cmd-no-middleware', (req, res) => {
  uploadToMemory.none()(req, res, () => {
    childProcess.exec(req.body.command, () => {
      res.end('DONE')
    })
  })
})

app.get('/', (req, res) => {
  res.status(200).send('hello world')
})

const server = http.createServer(app).listen(0, () => {
  const port = server.address().port
  process.send?.({ port })
})
