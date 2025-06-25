'use strict'

const Config = require('../src/config')
const { channel } = require('dc-polyfill')
const express = require('express')
const getPort = require('get-port')
const http = require('http')
const upload = require('multer')()
const proxyquire = require('proxyquire').noCallThru()

const t = require('tap')
require('./setup/core')

const debugChannel = channel('datadog:log:debug')

t.test('Flare', t => {
  let flare
  let startupLog
  let tracerConfig
  let task
  let port
  let server
  let listener
  let socket
  let handler

  const createServer = () => {
    const app = express()

    app.post('/tracer_flare/v1', upload.any(), (req, res) => {
      res.sendStatus(200)
      handler(req)
    })

    server = http.createServer(app)
    server.on('connection', socket_ => {
      socket = socket_
    })

    listener = server.listen(port)
  }

  t.beforeEach(() => {
    startupLog = {
      tracerInfo: () => ({
        lang: 'nodejs'
      })
    }

    flare = proxyquire('../src/flare', {
      '../startup-log': startupLog
    })

    return getPort().then(port_ => {
      port = port_
    })
  })

  t.beforeEach(() => {
    tracerConfig = new Config({
      url: `http://127.0.0.1:${port}`
    })

    task = {
      case_id: '111',
      hostname: 'myhostname',
      user_handle: 'user.name@datadoghq.com'
    }

    createServer()
  })

  t.afterEach(async () => {
    handler = null
    flare.disable()
    listener.close()
    socket && socket.end()
    server.on('close', () => {
      server = null
      listener = null
      socket = null

      t.end()
    })
  })

  t.test('should send a flare', t => {
    handler = req => {
      try {
        expect(req.body).to.include({
          case_id: task.case_id,
          hostname: task.hostname,
          email: task.user_handle,
          source: 'tracer_nodejs'
        })

        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }

    flare.enable(tracerConfig)
    flare.send(task)
  })

  t.test('should send the tracer info', t => {
    handler = req => {
      try {
        expect(req.files).to.have.length(1)
        expect(req.files[0]).to.include({
          fieldname: 'flare_file',
          originalname: 'tracer_info.txt',
          mimetype: 'application/octet-stream'
        })

        const content = JSON.parse(req.files[0].buffer.toString())

        expect(content).to.have.property('lang', 'nodejs')

        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }

    flare.enable(tracerConfig)
    flare.send(task)
  })

  t.test('should send the tracer logs', t => {
    handler = req => {
      try {
        const file = req.files[0]

        if (file.originalname !== 'tracer_logs.txt') return

        expect(file).to.include({
          fieldname: 'flare_file',
          originalname: 'tracer_logs.txt',
          mimetype: 'application/octet-stream'
        })

        const content = file.buffer.toString()

        expect(content).to.equal('foo\nbar\n{"foo":"bar"}\n')

        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }

    flare.enable(tracerConfig)
    flare.prepare('debug')

    debugChannel.publish('foo')
    debugChannel.publish('bar')
    debugChannel.publish({ foo: 'bar' })

    flare.send(task)
  })
  t.end()
})
