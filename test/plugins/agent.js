'use strict'

const http = require('http')
const bodyParser = require('body-parser')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const getPort = require('get-port')
const express = require('express')
const path = require('path')

const handlers = new Set()
let agent = null
let server = null
let listener = null
let tracer = null

module.exports = {
  // Load the plugin on the tracer with an optional config and start a mock agent.
  load (plugin, pluginName, config) {
    tracer = require('../..')
    agent = express()
    agent.use(bodyParser.raw({ type: 'application/msgpack' }))
    agent.use((req, res, next) => {
      if (req.body.length === 0) return res.status(200).send()
      req.body = msgpack.decode(req.body, { codec })
      next()
    })

    agent.put('/v0.4/traces', (req, res) => {
      res.status(200).send('OK')
      handlers.forEach(handler => handler(req.body))
    })

    return getPort().then(port => {
      return new Promise((resolve, reject) => {
        server = http.createServer(agent)

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

  // Register a callback with expectations to be run on every agent call.
  use (callback) {
    const deferred = {}
    const promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve
      deferred.reject = reject
    })

    const timeout = setTimeout(() => {
      if (error) {
        deferred.reject(error)
      }
    }, 1000)

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
    const scope = tracer.scopeManager().active()
    return scope ? scope.span() : null
  },

  // Stop the mock agent, reset all expectations and wipe the require cache.
  close () {
    this.wipe()

    listener.close()
    listener = null
    agent = null
    handlers.clear()
    delete require.cache[require.resolve('../..')]

    return new Promise((resolve, reject) => {
      server.on('close', () => {
        server = null

        resolve()
      })
    })
  },

  // Wipe the require cache.
  wipe () {
    const basedir = path.join(__dirname, 'versions')

    Object.keys(require.cache)
      .filter(name => name.indexOf(basedir) !== -1)
      .forEach(name => {
        delete require.cache[name]
      })
  }
}
