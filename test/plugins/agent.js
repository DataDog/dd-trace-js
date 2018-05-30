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
let handlers = []
let skip = []

module.exports = {
  load (plugin, moduleToPatch, config) {
    tracer = require('../..')
    agent = express()
    agent.use(bodyParser.raw({ type: 'application/msgpack' }))
    agent.use((req, res, next) => {
      req.body = msgpack.decode(req.body, { codec })
      next()
    })

    agent.put('/v0.3/traces', (req, res) => {
      res.status(200).send('OK')

      if (skip[0]) {
        skip[0].resolve()
        skip.shift()
      } else if (handlers[0]) {
        handlers[0](req.body)
        handlers.shift()
      }
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
    return new Promise((resolve, reject) => {
      handlers.push(function () {
        try {
          callback.apply(null, arguments)
          resolve()
        } catch (e) {
          reject(e)
        }
      })
    })
  },

  skip (count) {
    for (let i = 0; i < count; i++) {
      const defer = {}

      defer.promise = new Promise((resolve, reject) => {
        defer.resolve = resolve
        defer.reject = reject
      })

      skip.push(defer)
    }
  },

  currentSpan () {
    return tracer.currentSpan()
  },

  close () {
    const timeout = setTimeout(() => {
      skip.forEach(defer => defer.resolve())
    }, 1000)

    return Promise.all(skip.map(defer => defer.promise))
      .then(() => {
        clearTimeout(timeout)
        listener.close()
        listener = null
        agent = null
        handlers = []
        skip = []
        delete require.cache[require.resolve('../..')]
      })
  }
}
