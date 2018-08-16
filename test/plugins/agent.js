'use strict'

const http = require('http')
const bodyParser = require('body-parser')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const getPort = require('get-port')
const express = require('express')
const path = require('path')

let agent = null
let listener = null
let tracer = null
let handlers = []
let promise
let skip = []

module.exports = {
  load (plugin, pluginName, config) {
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

        tracer.use(pluginName, config)
      })
    })
  },

  use (callback, count) {
    count = count || 1
    promise = Promise.reject(new Error('No request was expected.'))

    for (let i = 0; i < count; i++) {
      promise = promise.catch(() => new Promise((resolve, reject) => {
        handlers.push(function () {
          try {
            callback.apply(null, arguments)
            resolve()
          } catch (e) {
            reject(e)
          }
        })
      }))
    }

    return promise
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
    const scope = tracer.scopeManager().active()
    return scope ? scope.span() : null
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
  },

  wipe () {
    const basedir = path.join(__dirname, 'versions')

    Object.keys(require.cache)
      .filter(name => name.indexOf(basedir) !== -1)
      .forEach(name => {
        delete require.cache[name]
      })
  }
}
