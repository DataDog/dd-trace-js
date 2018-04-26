'use strict'

const http = require('http')
const bodyParser = require('body-parser')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const getPort = require('get-port')
const express = require('express')

let agent = null
let listener = null
let tracer = null

module.exports = {
  load (plugin, moduleToPatch, config) {
    tracer = require('../..')
    agent = express()
    agent.use(bodyParser.raw({ type: 'application/msgpack' }))
    agent.use((req, res, next) => {
      req.body = msgpack.decode(req.body, { codec })
      next()
    })

    return getPort().then(port => {
      return new Promise((resolve, reject) => {
        const server = http.createServer(agent)

        listener = server.listen(port, 'localhost', resolve)

        server.on('close', () => {
          tracer._instrumenter.unpatch()
          tracer = null
        })

        tracer.init({
          service: 'test',
          port,
          flushInterval: 0,
          plugins: false
        })

        tracer.use(plugin, config)

        require(moduleToPatch)
      })
    })
  },

  use (callback) {
    agent.put('/v0.3/traces', (req, res) => {
      res.status(200).send('OK')
      callback(req.body)
    })
  },

  currentSpan () {
    return tracer.currentSpan()
  },

  close () {
    listener.close()
    listener = null
    agent = null
    delete require.cache[require.resolve('../..')]
  }
}
