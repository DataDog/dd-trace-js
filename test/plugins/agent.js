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
let listener = null
let tracer = null
let skipped = []

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
      handlers.forEach(handler => handler(req.body))
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

  // use (callback, count) {
  //   count = count || 1
  //   promise = Promise.reject(new Error('No request was expected.'))

  //   for (let i = 0; i < count; i++) {
  //     promise = promise.catch(() => new Promise((resolve, reject) => {
  //       handlers.push(function () {
  //         try {
  //           callback.apply(null, arguments)
  //           resolve()
  //         } catch (e) {
  //           reject(e)
  //         }
  //       })
  //     }))
  //   }

  //   return promise
  // },

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

  promise () {
    const promises = Array.from(handlers)
      .map(handler => handler.promise.catch(e => e))

    return Promise.all(promises)
      .then(results => results.find(e => e instanceof Error))
  },

  reset () {
    handlers.clear()
  },

  wrap (callback) {
    return error => {
      this.promise()
        .then(err => callback(error || err))
    }
  },

  currentSpan () {
    const scope = tracer.scopeManager().active()
    return scope ? scope.span() : null
  },

  close () {
    const timeout = setTimeout(() => {
      skipped.forEach(defer => defer.resolve())
    }, 1000)

    this.wipe()

    return Promise.all(skipped.map(defer => defer.promise))
      .then(() => {
        clearTimeout(timeout)
        listener.close()
        listener = null
        agent = null
        handlers.clear()
        skipped = []
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
