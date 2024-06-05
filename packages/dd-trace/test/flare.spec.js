'use strict'

const Config = require('../src/config')
const { channel } = require('dc-polyfill')
const express = require('express')
const getPort = require('get-port')
const http = require('http')
const upload = require('multer')()
const proxyquire = require('proxyquire').noCallThru()

require('./setup/tap')

const debugChannel = channel('datadog:log:debug')

describe('Flare', () => {
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

  beforeEach(() => {
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

  beforeEach(() => {
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

  afterEach(done => {
    handler = null
    flare.disable()
    listener.close()
    socket && socket.end()
    server.on('close', () => {
      server = null
      listener = null
      socket = null

      done()
    })
  })

  it('should send a flare', done => {
    handler = req => {
      try {
        expect(req.body).to.include({
          case_id: task.case_id,
          hostname: task.hostname,
          email: task.user_handle,
          source: 'tracer_nodejs'
        })

        done()
      } catch (e) {
        done(e)
      }
    }

    flare.enable(tracerConfig)
    flare.send(task)
  })

  it('should send the tracer info', done => {
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

        done()
      } catch (e) {
        done(e)
      }
    }

    flare.enable(tracerConfig)
    flare.send(task)
  })

  it('should send the tracer logs', done => {
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

        expect(content).to.equal('foo\nbar\n')

        done()
      } catch (e) {
        done(e)
      }
    }

    flare.enable(tracerConfig)
    flare.prepare('debug')

    debugChannel.publish('foo')
    debugChannel.publish('bar')

    flare.send(task)
  })
})
