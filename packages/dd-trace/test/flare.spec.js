'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')

const { channel } = require('dc-polyfill')
const express = require('express')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const upload = require('multer')()
const proxyquire = require('proxyquire').noCallThru()
const { describe, it, beforeEach, afterEach } = require('tap').mocha

require('./setup/core')

const { getConfigFresh } = require('./helpers/config')

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

  const createServer = (done) => {
    const app = express()

    app.post('/tracer_flare/v1', upload.any(), (req, res) => {
      res.sendStatus(200)
      handler(req)
    })

    server = http.createServer(app)
    server.on('connection', socket_ => {
      socket = socket_
    })

    listener = server.listen(0, '127.0.0.1', () => {
      port = server.address().port
      done()
    })
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
  })

  beforeEach(createServer)

  beforeEach(() => {
    tracerConfig = getConfigFresh({
      url: `http://127.0.0.1:${port}`
    })

    task = {
      case_id: '111',
      hostname: 'myhostname',
      user_handle: 'user.name@datadoghq.com'
    }
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
        assertObjectContains(req.body, {
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
        assert.strictEqual(req.files.length, 1)
        assertObjectContains(req.files[0], {
          fieldname: 'flare_file',
          originalname: 'tracer_info.txt',
          mimetype: 'application/octet-stream'
        })

        const content = JSON.parse(req.files[0].buffer.toString())

        assert.strictEqual(content.lang, 'nodejs')

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

        assertObjectContains(file, {
          fieldname: 'flare_file',
          originalname: 'tracer_logs.txt',
          mimetype: 'application/octet-stream'
        })

        const content = file.buffer.toString()

        assert.strictEqual(content, 'foo\nbar\n{"foo":"bar"}\n')

        done()
      } catch (e) {
        done(e)
      }
    }

    flare.enable(tracerConfig)
    flare.prepare('debug')

    debugChannel.publish('foo')
    debugChannel.publish('bar')
    debugChannel.publish({ foo: 'bar' })

    flare.send(task)
  })
})
