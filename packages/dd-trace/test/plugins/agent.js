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

function isMatchingTrace (spans, spanResourceMatch) {
  if (!spanResourceMatch) {
    return true
  }
  return !!spans.find(span => spanResourceMatch.test(span.resource))
}

function ciVisRequestHandler (request, response) {
  response.status(200).send('OK')
  handlers.forEach(({ handler, spanResourceMatch }) => {
    const { events } = request.body
    const spans = events.map(event => event.content)
    if (isMatchingTrace(spans, spanResourceMatch)) {
      handler(request.body, request)
    }
  })
}

function addEnvironmentVariablesToHeaders (headers, traces) {
  return new Promise((resolve, reject) => {
    // get all environment variables that start with "DD_"
    var ddEnvVars = new Map(
      Object.entries(process.env)
        .filter(([key]) => key.startsWith('DD_'))
        .map(([key, value]) => [key, value])
    )
    if (global.testAgentServiceName) {
      ddEnvVars.set('DD_SERVICE', global.testAgentServiceName)
    // } else if (tracer.service && tracer.service != process.env["DD_SERVICE"]) {
    //   ddEnvVars.set('DD_SERVICE', tracer.service)
    }
    ddEnvVars.set('DD_TRACE_SPAN_ATTRIBUTE_SCHEMA', global.schemaVersionName)
  
    for (let i = 0; i < plugins.length; i++) {
      var plugin_name = plugins[i]
      if (tracer._pluginManager._configsByName[plugin_name] && tracer._pluginManager._configsByName[plugin_name].service) {
        ddEnvVars.set(`DD_${plugin_name.toUpperCase()}_SERVICE`, tracer._pluginManager._configsByName[plugin_name].service)
      }
    }

    // serialize the DD environment variables into a string of k=v pairs separated by comma
    var serializedEnvVars = Array.from(ddEnvVars.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join(',')

    // add the serialized DD environment variables to the header
    // to send with trace to the final agent destination
    headers['X-Datadog-Trace-Env-Variables'] = serializedEnvVars

    resolve(headers)
  })
}

async function handleTraceRequest (req, res, sendToTestAgent) {
  // handles the received trace request and sends trace to Test Agent if bool enabled.
  let responseSent = false;
  if (sendToTestAgent) {
    const testAgentUrl = process.env.DD_TEST_AGENT_URL || 'http://127.0.0.1:9126'

    // remove incorrect headers
    delete req.headers['host']
    delete req.headers['content-type']
    delete req.headers['content-length']

    const testAgentRes = await new Promise(async (resolve, reject) => {
      await addEnvironmentVariablesToHeaders(req.headers, req.body)
      const testAgentReq = http.request(
        `${testAgentUrl}/v0.4/traces`, {
          method: 'PUT',
          headers: {
            ...req.headers,
            'X-Datadog-Agent-Proxy-Disabled': 'True',
            'Content-Type': 'application/json'
          }
        })

      testAgentReq.on('response', () => {
        res.status(200).send({ rate_by_service: { 'service:,env:': 1 } })
        resolve()
      })
      testAgentReq.on('error', () => {
        res.status(500).send(error)
        reject(error)
      })
      testAgentReq.write(JSON.stringify(req.body))
      testAgentReq.end()
    })
  } else {
    res.status(200).send({ rate_by_service: { 'service:,env:': 1 } })
  }

  handlers.forEach(({ handler, spanResourceMatch }) => {
    const trace = req.body
    const spans = trace.flatMap(span => span)
    if (isMatchingTrace(spans, spanResourceMatch)) {
      handler(trace)
    }
  })
}

function checkAgentStatus () {
  const agentUrl = process.env.DD_TRACE_AGENT_URL || 'http://127.0.0.1:9126'

  return new Promise((resolve, reject) => {
    const request = http.request(`${agentUrl}/info`, { method: 'GET' }, response => {
      if (response.statusCode === 200) {
        resolve(true)
      } else {
        resolve(false)
      }
    })

    request.on('error', error => {
      reject(error)
    })

    request.end()
  })
}

const DEFAULT_AVAILABLE_ENDPOINTS = ['/evp_proxy/v2']

let availableEndpoints = DEFAULT_AVAILABLE_ENDPOINTS

module.exports = {
  // Load the plugin on the tracer with an optional config and start a mock agent.
  async load (pluginName, config, tracerConfig = {}) {
    tracer = require('../..')
    agent = express()
    agent.use(bodyParser.raw({ limit: Infinity, type: 'application/msgpack' }))
    agent.use((req, res, next) => {
      if (req.is('application/msgpack')) {
        if (!req.body.length) return res.status(200).send()
        req.body = msgpack.decode(req.body, { codec })
      }
      next()
    })

    let useTestAgent

    try {
      useTestAgent = await checkAgentStatus()
    } catch (error) {
      useTestAgent = false
    }

    agent.get('/info', (req, res) => {
      res.status(202).send({
        endpoints: availableEndpoints
      })
    })

    agent.put('/v0.5/traces', (req, res) => {
      res.status(404).end()
    })

    agent.put('/v0.4/traces', async (req, res) => {
      await handleTraceRequest(req, res, useTestAgent)
    })

    // CI Visibility Agentless intake
    agent.post('/api/v2/citestcycle', ciVisRequestHandler)

    // EVP proxy endpoint
    agent.post('/evp_proxy/v2/api/v2/citestcycle', ciVisRequestHandler)

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
   * @param {boolean} [options.rejectFirst=false] - If true, reject the first time the callback throws.
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
    const handlerPayload = { handler, spanResourceMatch: options && options.spanResourceMatch }

    function handler () {
      try {
        callback.apply(null, arguments)
        handlers.delete(handlerPayload)
        clearTimeout(timeout)
        deferred.resolve()
      } catch (e) {
        if (options && options.rejectFirst) {
          clearTimeout(timeout)
          deferred.reject(e)
        } else {
          error = error || e
        }
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
    this.setAvailableEndpoints(DEFAULT_AVAILABLE_ENDPOINTS)

    return new Promise((resolve, reject) => {
      this.server.on('close', () => {
        this.server = null

        resolve()
      })
    })
  },

  setAvailableEndpoints (newEndpoints) {
    availableEndpoints = newEndpoints
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
