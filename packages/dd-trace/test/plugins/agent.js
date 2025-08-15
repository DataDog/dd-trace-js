'use strict'

const http = require('http')
const bodyParser = require('body-parser')
const msgpack = require('@msgpack/msgpack')
const express = require('express')
const path = require('path')
const ritm = require('../../src/ritm')
const { storage } = require('../../../datadog-core')
const { assertObjectContains } = require('../../../../integration-tests/helpers')
const { expect } = require('chai')

const traceHandlers = new Set()
const statsHandlers = new Set()
let sockets = []
let agent = null
let listener = null
let tracer = null
let plugins = []
const testedPlugins = []
let dsmStats = []
let currentIntegrationName = null

function isMatchingTrace (spans, spanResourceMatch) {
  if (!spanResourceMatch) {
    return true
  }
  return !!spans.find(span => spanResourceMatch.test(span.resource))
}

function ciVisRequestHandler (request, response) {
  response.status(200).send('OK')
  traceHandlers.forEach(({ handler, spanResourceMatch }) => {
    const { events } = request.body
    const spans = events.map(event => event.content)
    if (isMatchingTrace(spans, spanResourceMatch)) {
      handler(request.body, request)
    }
  })
}

function dsmStatsExist (agent, expectedHash, expectedEdgeTags) {
  const dsmStats = agent.getDsmStats()
  let hashFound = false
  if (dsmStats.length !== 0) {
    for (const statsTimeBucket of dsmStats) {
      for (const statsBucket of statsTimeBucket.Stats) {
        for (const stats of statsBucket.Stats) {
          if (stats.Hash.toString() === expectedHash) {
            if (expectedEdgeTags) {
              if (expectedEdgeTags.length !== stats.EdgeTags.length) {
                return false
              }

              const expected = expectedEdgeTags.slice().sort()
              const actual = stats.EdgeTags.slice().sort()

              for (let i = 0; i < expected.length; i++) {
                if (expected[i] !== actual[i]) {
                  return false
                }
              }
            }
            hashFound = true
            return hashFound
          }
        }
      }
    }
  }
  return hashFound
}

function dsmStatsExistWithParentHash (agent, expectedParentHash) {
  const dsmStats = agent.getDsmStats()
  let hashFound = false
  if (dsmStats.length !== 0) {
    for (const statsTimeBucket of dsmStats) {
      for (const statsBucket of statsTimeBucket.Stats) {
        for (const stats of statsBucket.Stats) {
          if (stats.ParentHash.toString() === expectedParentHash) {
            hashFound = true
            return hashFound
          }
        }
      }
    }
  }
  return hashFound
}

function unformatSpanEvents (span) {
  if (span.meta && span.meta.events) {
    // Parse the JSON string back into an object
    const events = JSON.parse(span.meta.events)

    // Create the _events array
    const spanEvents = events.map(event => {
      return {
        name: event.name,
        startTime: event.time_unix_nano / 1e6, // Convert from nanoseconds back to milliseconds
        attributes: event.attributes ? event.attributes : undefined
      }
    })

    // Return the unformatted _events
    return spanEvents
  }

  return [] // Return an empty array if no events are found
}

function addEnvironmentVariablesToHeaders (headers, testConfig) {
  // get all environment variables that start with "DD_"
  const ddEnvVars = new Map(
    Object.entries(process.env)
      .filter(([key]) => key.startsWith('DD_'))
  )

  if (testConfig) {
    for (const key in testConfig) {
      if (!ddEnvVars.has(key)) {
        ddEnvVars.set(key, testConfig[key])
      }
    }
  }

  // add plugin name and plugin version to headers, this is used for verifying tested
  // integration version ranges
  const currentPlugin = testedPlugins[testedPlugins.length - 1]
  if (currentPlugin && currentPlugin.pluginName && currentPlugin.pluginVersion) {
    ddEnvVars.set('DD_INTEGRATION', currentPlugin.pluginName)
    ddEnvVars.set('DD_INTEGRATION_VERSION', currentPlugin.pluginVersion)
  }

  // add the DD environment variables to the header if any exist
  // to send with trace to final agent destination
  if (ddEnvVars.size > 0) {
    // serialize the DD environment variables into a string of k=v pairs separated by comma
    const serializedEnvVars = Array.from(ddEnvVars.entries())
      .map(([key, value]) => {
        if (typeof value === 'object' && value !== null) {
          return `${key}=${JSON.stringify(value)}`
        }
        return `${key}=${value}`
      })
      .join(',')

    // add the serialized DD environment variables to the header
    // to send with trace to the final agent destination
    headers['X-Datadog-Trace-Env-Variables'] = serializedEnvVars
  }
}

function handleTraceRequest (req, res, sendToTestAgent) {
  // handles the received trace request and sends trace to Test Agent if bool enabled.
  if (sendToTestAgent) {
    const testAgentUrl = process.env.DD_TEST_AGENT_URL || 'http://127.0.0.1:9126'
    const replacer = (k, v) => typeof v === 'bigint' ? Number(v) : v

    // remove incorrect headers
    delete req.headers.host
    delete req.headers['content-type']
    delete req.headers['content-length']

    // add current environment variables to trace headers
    const testConfig = req.body[0]?.[0]?.meta?.['_dd.ci.test_config']
    addEnvironmentVariablesToHeaders(req.headers, testConfig)

    const testAgentReq = http.request(
      `${testAgentUrl}/v0.4/traces`, {
        method: 'PUT',
        headers: {
          ...req.headers,
          'X-Datadog-Agent-Proxy-Disabled': 'False',
          'Content-Type': 'application/json'
        }
      })

    testAgentReq.on('response', testAgentRes => {
      if (res._closed) {
        // Skip handling for already closed agents
        return
      }

      if (testAgentRes.statusCode !== 200) {
        // handle request failures from the Test Agent here
        let body = ''
        testAgentRes.on('data', chunk => {
          body += chunk
        })
        testAgentRes.on('end', () => {
          res.status(400).send(body)
        })
      }
    })
    testAgentReq.write(JSON.stringify(req.body, replacer))
    testAgentReq.end()
  }

  res.status(200).send({ rate_by_service: { 'service:,env:': 1 } })
  traceHandlers.forEach(({ handler, spanResourceMatch }) => {
    const trace = req.body
    const spans = trace.flatMap(span => span)
    if (isMatchingTrace(spans, spanResourceMatch)) {
      handler(trace)
    }
  })
}

function checkAgentStatus () {
  const agentUrl = process.env.DD_TRACE_AGENT_URL || 'http://127.0.0.1:9126'

  return new Promise((resolve) => {
    const request = http.request(`${agentUrl}/info`, { method: 'GET' }, response => {
      if (response.statusCode === 200) {
        resolve(true)
      } else {
        resolve(false)
      }
    })

    request.on('error', (_error_) => {
      resolve(false)
    })

    request.end()
  })
}

function getDsmStats () {
  return dsmStats
}

function getCurrentIntegrationName () {
  // gets the current integration name from the stack trace, used to determine if these tests are
  // integration tests or not
  const stack = new Error().stack
  // The regex looks for /packages/datadog-plugin-NAME/test/ in the stack trace
  const pluginTestRegex = /packages\/datadog-plugin-([^/]+)\/test/
  const match = stack.match(pluginTestRegex)

  return match ? match[1] : null
}

function assertIntegrationName (args) {
  // we want to assert that all spans generated by an instrumentation have the right `_dd.integration` tag set
  if (currentIntegrationName) {
    const traces = args[0]
    if (traces && Array.isArray(traces)) {
      traces.forEach(trace => {
        if (Array.isArray(trace)) {
          trace.forEach(span => {
            // ignore everything that has no component (i.e. manual span)
            // ignore everything that has already the component == _dd.integration
            if (span && span.meta && span.meta.component && span.meta.component !== span.meta['_dd.integration']) {
              expect(span.meta['_dd.integration']).to.equal(
                currentIntegrationName,
                 `Expected span to have "_dd.integration" tag "${currentIntegrationName}"
                 but found "${span.meta['_dd.integration']}" for span ID ${span.span_id}`
              )
            }
          })
        }
      })
    }
  }
}

const DEFAULT_AVAILABLE_ENDPOINTS = ['/evp_proxy/v2']
let availableEndpoints = DEFAULT_AVAILABLE_ENDPOINTS

/**
 * Register a callback with expectations to be run on every tracing or stats payload sent to the agent depending
 * on the handlers inputted. If the callback does not throw, the returned promise resolves. If it does,
 * then the agent will wait for additional payloads up until the timeout
 * (default 1000 ms) and if any of them succeed, the promise will resolve.
 * Otherwise, it will reject.
 *
 * @param {(traces: Array<Array<object>>) => void} callback - A function that tests a payload as it's received.
 * @param {Object} [options] - An options object
 * @param {number} [options.timeoutMs=1000] - The timeout in ms.
 * @param {boolean} [options.rejectFirst=false] - If true, reject the first time the callback throws.
 * @param {Set} [handlers] - Set of handlers to add the callback to.
 * @returns {Promise<void>} A promise resolving if expectations are met
 */
function runCallbackAgainstTraces (callback, options, handlers) {
  let error

  let resolve
  let reject
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  const rejectionTimeout = setTimeout(() => {
    if (error) reject(error)
  }, options?.timeoutMs || 1000)

  const handlerPayload = {
    handler,
    spanResourceMatch: options?.spanResourceMatch
  }

  function handler () {
    // we assert integration name being tagged on all spans (when running integration tests)
    assertIntegrationName(arguments)

    try {
      const result = callback.apply(null, arguments)
      handlers.delete(handlerPayload)
      clearTimeout(rejectionTimeout)
      resolve(result)
    } catch (e) {
      if (options?.rejectFirst) {
        clearTimeout(rejectionTimeout)
        reject(e)
      } else {
        error = error || e // if no spans match we report exactly the first mismatch error (which is unintuitive)
      }
    }
  }

  handler.promise = promise
  handlers.add(handlerPayload)

  return promise
}

module.exports = {
  /**
   * Load the plugin on the tracer with an optional config and start a mock agent.
   *
   * @param {String|Array<String>} pluginName - Name or list of names of plugins to load
   * @param {Record<string, unknown>} [config]
   * @param {Record<string, unknown>} [tracerConfig={}]
   * @returns Promise<void>
   */
  async load (pluginName, config, tracerConfig = {}) {
    currentIntegrationName = getCurrentIntegrationName()

    tracer = require('../..')
    agent = express()
    agent.use(bodyParser.raw({ limit: Infinity, type: 'application/msgpack' }))
    agent.use((req, res, next) => {
      if (req.is('application/msgpack')) {
        if (!req.body.length) return res.status(200).send()
        req.body = msgpack.decode(req.body, { useBigInt64: true })
      }
      next()
    })

    const innerAgent = agent

    const useTestAgent = await checkAgentStatus()

    if (agent !== innerAgent) {
      throw new Error('Agent got replaced since last load')
    }

    agent.get('/info', (req, res) => {
      res.status(202).send({
        endpoints: availableEndpoints
      })
    })

    agent.put('/v0.5/traces', (req, res) => {
      res.status(404).end()
    })

    agent.put('/v0.4/traces', (req, res) => {
      handleTraceRequest(req, res, useTestAgent)
    })

    // CI Visibility Agentless intake
    agent.post('/api/v2/citestcycle', ciVisRequestHandler)

    // EVP proxy endpoint
    agent.post('/evp_proxy/v2/api/v2/citestcycle', ciVisRequestHandler)

    // DSM Checkpoint endpoint
    dsmStats = []
    agent.post('/v0.1/pipeline_stats', (req, res) => {
      dsmStats.push(req.body)
      statsHandlers.forEach(({ handler, spanResourceMatch }) => {
        handler(dsmStats)
      })
      res.status(200).send()
    })

    const server = this.server = http.createServer(agent)
    const emit = server.emit

    server.emit = function () {
      storage('legacy').enterWith({ noop: true })
      return emit.apply(this, arguments)
    }

    server.on('connection', socket => sockets.push(socket))

    const promise = new Promise((resolve, _reject) => {
      listener = server.listen(0, () => {
        const port = listener.address().port

        tracer.init(Object.assign({}, {
          service: 'test',
          env: 'tester',
          port,
          flushInterval: 0,
          plugins: false,
          isCiVisibility: true
        }, tracerConfig))

        tracer.setUrl(`http://127.0.0.1:${port}`)

        for (let i = 0, l = pluginName.length; i < l; i++) {
          tracer.use(pluginName[i], config[i])
        }

        resolve()
      })
    })

    pluginName = [].concat(pluginName)
    plugins = pluginName
    config = [].concat(config)

    server.on('close', () => {
      tracer = null
      dsmStats = []
      currentIntegrationName = null
    })

    return promise
  },

  reload (pluginName, config) {
    pluginName = [].concat(pluginName)
    plugins = pluginName
    config = [].concat(config)
    dsmStats = []

    for (let i = 0, l = pluginName.length; i < l; i++) {
      tracer.use(pluginName[i], config[i])
    }
  },

  /**
   * Register handler to be executed on each agent call, multiple times
   * @param {Function} handler
   */
  subscribe (handler) {
    traceHandlers.add({ handler }) // TODO: SHOULD BE .add(handler) SO WE CAN DELETE
  },

  /**
   * Remove a handler (TODO: THIS DOES NOTHING)
   * @param {Function} handler
   */
  unsubscribe (handler) {
    traceHandlers.delete(handler)
  },

  /**
   * Callback for running test assertions against traces.
   *
   * @callback testAssertionTracesCallback
   * @param {Array.<Array.<span>>} traces - For a given payload, an array of traces, each trace is an array of spans.
   */

  /**
   * Callback for running test assertions against a span.
   *
   * @callback testAssertionSpanCallback
   * @param {span} span - For a given payload, the first span of the first trace.
   */

  /**
   * This callback gets executed once for every payload received by the agent.
   * It calls the callback with a `traces` argument which is an array of traces.
   * Each of these traces is an array of spans.
   *
   * @param {testAssertionTracesCallback} callback - runs once per agent payload
   * @param {Object} [options] - An options object
   * @param {number} [options.timeoutMs=1000] - The timeout in ms.
   * @param {boolean} [options.rejectFirst=false] - If true, reject the first time the callback throws.
   * @returns Promise
   */
  assertSomeTraces (callback, options) {
    return runCallbackAgainstTraces(callback, options, traceHandlers)
  },

  /**
   * Same as assertSomeTraces() but only provides the first span (traces[0][0])
   * This callback gets executed once for every payload received by the agent.

   * @param {testAssertionSpanCallback|Record<string|symbol, unknown>} callbackOrExpected - runs once per agent payload
   * @param {Object} [options] - An options object
   * @param {number} [options.timeoutMs=1000] - The timeout in ms.
   * @param {boolean} [options.rejectFirst=false] - If true, reject the first time the callback throws.
   * @returns Promise
   */
  assertFirstTraceSpan (callbackOrExpected, options) {
    return runCallbackAgainstTraces(function (traces) {
      if (typeof callbackOrExpected !== 'function') {
        try {
          assertObjectContains(traces[0][0], callbackOrExpected)
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('Expected span %o did not match traces:\n%o', callbackOrExpected, traces)
          throw error
        }
      } else {
        return callbackOrExpected(traces[0][0])
      }
    }, options, traceHandlers)
  },

  /**
   * Register a callback with expectations to be run on every stats payload sent to the agent.
   */
  expectPipelineStats (callback, options) {
    return runCallbackAgainstTraces(callback, options, statsHandlers)
  },

  /**
   * Unregister any outstanding expectation callbacks.
   */
  reset () {
    traceHandlers.clear()
    statsHandlers.clear()
  },

  /**
   * Stop the mock agent, reset all expectations and wipe the require cache.
   * @param {Object} [options]
   * @param {boolean} [options.ritmReset=true] - Resets the Require In The Middle cache. You probably don't need this.
   * @param {boolean} [options.wipe=false] - Wipes tracer and non-native modules from require cache. You probably don't
   *     need this.
   * @returns
   */
  close ({ ritmReset = true, wipe = false } = {}) {
    // Allow close to be called idempotent
    if (listener === null) {
      return Promise.resolve()
    }

    listener.close()
    listener = null
    sockets.forEach(socket => socket.end())
    sockets = []
    agent = null
    traceHandlers.clear()
    statsHandlers.clear()
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
    currentIntegrationName = null

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
  },

  tracer,
  testedPlugins,
  getDsmStats,
  dsmStatsExist,
  dsmStatsExistWithParentHash,
  unformatSpanEvents
}
