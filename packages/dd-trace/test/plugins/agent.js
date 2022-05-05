'use strict'

const http = require('http')
const bodyParser = require('body-parser')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const getPort = require('get-port')
const express = require('express')
const path = require('path')
const ritm = require('../../src/ritm')
const { storage } = require('../../../datadog-core')

const handlers = new Set()
let sockets = []
let agent = null
let listener = null
let tracer = null
let plugins = []

module.exports = {
  // Load the plugin on the tracer with an optional config and start a mock agent.
  load (pluginName, config, tracerConfig = {}) {
    tracer = require('../..')
    agent = express()
    agent.use(bodyParser.raw({ limit: Infinity, type: 'application/msgpack' }))
    agent.use((req, res, next) => {
      if (!req.body.length) return res.status(200).send()
      req.body = msgpack.decode(req.body, { codec })
      next()
    })

    agent.put('/v0.5/traces', (req, res) => {
      res.status(404).end()
    })

    agent.put('/v0.4/traces', (req, res) => {
      res.status(200).send({ rate_by_service: { 'service:,env:': 1 } })
      handlers.forEach(handler => handler(req.body))
    })

    return getPort().then(port => {
      return new Promise((resolve, reject) => {
        const server = this.server = http.createServer(agent)
        const emit = server.emit

        server.emit = function () {
          storage.enterWith({ noop: true })
          return emit.apply(this, arguments)
        }

        server.on('connection', socket => sockets.push(socket))

        listener = server.listen(port, () => resolve())

        pluginName = [].concat(pluginName)
        plugins = pluginName
        config = [].concat(config)

        server.on('close', () => {
          tracer._instrumenter.disable()
          tracer = null
        })

        tracer.init(Object.assign({}, {
          service: 'test',
          port,
          flushInterval: 0,
          plugins: false
        }, tracerConfig))

        for (let i = 0, l = pluginName.length; i < l; i++) {
          tracer.use(pluginName[i], config[i])
        }
      })
    })
  },

  // Register a callback with expectations to be run on every agent call.
  use (callback, options) {
    const deferred = {}
    const promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve
      deferred.reject = reject
    })

    const timeoutMs = options && typeof options === 'object' && options.timeoutMs ? options.timeoutMs : 1000

    const timeout = setTimeout(() => {
      if (error) {
        deferred.reject(error)
      }
    }, timeoutMs)

    let error

    const handler = function () {
      try {
        callback.apply(null, arguments)
        handlers.delete(handler)
        clearTimeout(timeout)
        deferred.resolve()
      } catch (e) {
        error = error || e
      }
    }

    handler.promise = promise
    handlers.add(handler)

    return promise
  },

  // Return a promise that will resolve when all expectations have run.
  promise () {
    const promises = Array.from(handlers)
      .map(handler => handler.promise.catch(e => e))

    return Promise.all(promises)
      .then(results => results.find(e => e instanceof Error))
  },

  // Unregister any outstanding expectation callbacks.
  reset () {
    handlers.clear()
  },

  // Wrap a callback so it will only be called when all expectations have run.
  wrap (callback) {
    return error => {
      this.promise()
        .then(err => callback(error || err))
    }
  },

  // Return the current active span.
  currentSpan () {
    return tracer.scope().active()
  },

  // Stop the mock agent, reset all expectations and wipe the require cache.
  close (opts = {}) {
    const { ritmReset } = opts
    this.wipe()

    listener.close()
    listener = null
    sockets.forEach(socket => socket.end())
    sockets = []
    agent = null
    handlers.clear()
    if (ritmReset !== false) {
      ritm.reset()
    }
    delete require.cache[require.resolve('../..')]
    for (const plugin of plugins) {
      tracer.use(plugin, { enabled: false })
    }
    delete global._ddtrace

    return new Promise((resolve, reject) => {
      this.server.on('close', () => {
        this.server = null

        resolve()
      })
    })
  },

  // Wipe the require cache.
  wipe () {
    const basedir = path.join(__dirname, '..', '..', '..', '..', 'versions')
    const exceptions = ['/libpq/', '/grpc/', '/sqlite3/', '/couchbase/'] // wiping native modules results in errors
      .map(exception => new RegExp(exception))

    Object.keys(require.cache)
      .filter(name => name.indexOf(basedir) !== -1)
      .filter(name => !exceptions.some(exception => exception.test(name)))
      .forEach(name => {
        delete require.cache[name]
      })
  }
}
