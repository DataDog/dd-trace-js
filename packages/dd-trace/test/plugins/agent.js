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
  async load (pluginName, config, tracerConfig = {}) {
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
      handlers.forEach(({ handler, traceMatch }) => {
        if (traceMatch) {
          if (traceMatch(req.body)) {
            handler(req.body)
          }
        } else {
          handler(req.body)
        }
      })
    })

    // CI Visibility Agentless intake
    agent.post('/api/v2/citestcycle', (req, res) => {
      res.status(200).send('OK')
      handlers.forEach(({ handler, traceMatch }) => {
        if (traceMatch) {
          if (traceMatch(req.body)) {
            handler(req.body)
          }
        } else {
          handler(req.body)
        }
      })
    })

    const port = await getPort()

    const server = this.server = http.createServer(agent)
    const emit = server.emit

    server.emit = function () {
      storage.enterWith({ noop: true })
      return emit.apply(this, arguments)
    }

    server.on('connection', socket => sockets.push(socket))

    const promise = new Promise((resolve, reject) => {
      listener = server.listen(port, () => resolve())
    })

    pluginName = [].concat(pluginName)
    plugins = pluginName
    config = [].concat(config)

    server.on('close', () => {
      tracer = null
    })

    tracer.init(Object.assign({}, {
      service: 'test',
      env: 'tester',
      port,
      flushInterval: 0,
      plugins: false
    }, tracerConfig))
    tracer.setUrl(`http://127.0.0.1:${port}`)

    for (let i = 0, l = pluginName.length; i < l; i++) {
      tracer.use(pluginName[i], config[i])
    }

    return promise
  },

  reload (pluginName, config) {
    pluginName = [].concat(pluginName)
    plugins = pluginName
    config = [].concat(config)

    for (let i = 0, l = pluginName.length; i < l; i++) {
      tracer.use(pluginName[i], config[i])
    }
  },

  // Register handler to be executed each agent call, multiple times
  subscribe (handler) {
    handlers.add({ handler })
  },

  // Remove a handler
  unsubscribe (handler) {
    handlers.delete(handler)
  },

  /**
   * Register a callback with expectations to be run on every tracing payload sent to the agent.
   * If the callback does not throw, the returned promise resolves. If it does,
   * then the agent will wait for additional payloads up until the timeout
   * (default 1000 ms) and if any of them succeed, the promise will resolve.
   * Otherwise, it will reject.
   *
   * @param {(traces: Array<Array<object>>) => void} callback - A function that tests trace data as it's received.
   * @param {Object} [options] - An options object
   * @param {number} [options.timeoutMs=1000] - The timeout in ms.
   * @returns {Promise<void>} A promise resolving if expectations are met
   */
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
    const handlerPayload = { handler, traceMatch: options && options.traceMatch }

    function handler () {
      try {
        callback.apply(null, arguments)
        handlers.delete(handlerPayload)
        clearTimeout(timeout)
        deferred.resolve()
      } catch (e) {
        error = error || e
      }
    }

    handler.promise = promise
    handlers.add(handlerPayload)

    return promise
  },

  // Unregister any outstanding expectation callbacks.
  reset () {
    handlers.clear()
  },

  // Stop the mock agent, reset all expectations and wipe the require cache.
  close (opts = {}) {
    const { ritmReset, wipe } = opts

    listener.close()
    listener = null
    sockets.forEach(socket => socket.end())
    sockets = []
    agent = null
    handlers.clear()
    for (const plugin of plugins) {
      tracer.use(plugin, { enabled: false })
    }
    if (ritmReset !== false) {
      ritm.reset()
    }
    if (wipe) {
      this.wipe()
    }
    return new Promise((resolve, reject) => {
      this.server.on('close', () => {
        this.server = null

        resolve()
      })
    })
  },

  // Wipe the require cache.
  wipe () {
    require('../..')._pluginManager.destroy()

    delete require.cache[require.resolve('../..')]
    delete global._ddtrace

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
