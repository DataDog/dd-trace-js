'use strict'

const assert = require('assert')
const util = require('util')
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
const llmobsHandlers = new Set()
let sockets = []
let agent = null
let listener = null
/** @type {import('../../src/index') | null} */
let tracer = null
/** @type {string[]} */
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

/**
 * Checks if a DSM stats object exists with a given hash and edge tags.
 *
 * @param {import('../../src/index')} agent
 * @param {string} expectedHash
 * @param {string[]} expectedEdgeTags
 * @returns {boolean}
 */
function dsmStatsExist (agent, expectedHash, expectedEdgeTags) {
  const dsmStats = agent.getDsmStats()
  const foundHashes = new Set()
  if (dsmStats.length !== 0) {
    for (const statsTimeBucket of dsmStats) {
      for (const statsBucket of statsTimeBucket.Stats) {
        for (const stats of statsBucket.Stats) {
          const currentHash = stats.Hash.toString()
          foundHashes.add(currentHash)
          if (currentHash === expectedHash) {
            if (expectedEdgeTags) {
              const expected = expectedEdgeTags.slice().sort()
              const actual = stats.EdgeTags.slice().sort()
              assert.deepStrictEqual(actual, expected, 'EdgeTags mismatch')
            }
            return true
          }
        }
      }
    }
  }
  throw new Error(`Hash not found. Expected: ${expectedHash}, Found hashes: ${util.inspect(foundHashes)}`)
}

/**
 * Checks if a DSM stats object exists with a given parent hash.
 *
 * @param {import('../../src/index')} agent
 * @param {string} expectedParentHash
 * @returns {boolean}
 */
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

/**
 * Unformats span events.
 *
 * @param {import('../../src/opentracing/span')} span
 * @returns {import('../../src/opentracing/span')[]}
 */
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

/**
 * Adds environment variables to headers.
 *
 * @param {http.IncomingHttpHeaders} headers
 */
function addEnvironmentVariablesToHeaders (headers) {
  // get all environment variables that start with "DD_"
  const ddEnvVars = new Map(
    Object.entries(process.env)
      .filter(([key]) => key.startsWith('DD_'))
  )

  // add plugin name and plugin version to headers, this is used for verifying tested
  // integration version ranges
  const currentPlugin = testedPlugins[testedPlugins.length - 1]
  if (currentPlugin && currentPlugin.pluginName && currentPlugin.pluginVersion) {
    ddEnvVars.set('DD_INTEGRATION', currentPlugin.pluginName)
    ddEnvVars.set('DD_INTEGRATION_VERSION', currentPlugin.pluginVersion)
  }

  // add the DD environment variables to the header if any exist
  // to send with trace to final agent destination
  // if (ddEnvVars.size > 0) {
  //   // TODO: Should we still do this? It has never worked until now.
  //   headers['X-Datadog-Trace-Env-Variables'] = [...ddEnvVars].map(([key, value]) => `${key}=${value}`).join(',')
  // }

  // serialize the DD environment variables into a string of k=v pairs separated by comma
  const serializedEnvVars = Array.from(ddEnvVars.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join(',')

  // add the serialized DD environment variables to the header
  // to send with trace to the final agent destination
  headers['X-Datadog-Trace-Env-Variables'] = serializedEnvVars
}

/**
 * Handles the received trace request and sends trace to Test Agent if bool enabled.
 *
 * @param {express.Request} req
 * @param {express.Response} res
 * @param {boolean} sendToTestAgent
 */
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
    addEnvironmentVariablesToHeaders(req.headers)

    const testAgentReq = http.request(
      `${testAgentUrl}/v0.4/traces`, {
        method: 'PUT',
        headers: {
          ...req.headers,
          'X-Datadog-Agent-Proxy-Disabled': 'True',
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
      resolve(response.statusCode === 200)
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
  const match = stack?.match(pluginTestRegex)

  return match ? match[1] : null
}

/**
 * @param {import('../../src/opentracing/span')[][]} traces
 */
function assertIntegrationName (traces) {
  // we want to assert that all spans generated by an instrumentation have the right `_dd.integration` tag set
  if (currentIntegrationName) {
    // TODO(BridgeAR): Should we just fail, if we do not receive an array of traces?
    if (Array.isArray(traces)) {
      traces.forEach(trace => {
        if (Array.isArray(trace)) {
          trace.forEach(span => {
            // ignore everything that has no component (i.e. manual span)
            // ignore everything that has already the component == _dd.integration
            if (span?.meta?.component && span.meta.component !== span.meta['_dd.integration']) {
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
 * The options for the runCallbackAgainstTraces function.
 *
 * If a number is provided, it will be used as the timeoutMs.
 *
 * Defaults:
 * - timeoutMs: 1000
 * - rejectFirst: false
 * - spanResourceMatch: undefined
 *
 * @typedef {Object} RunCallbackAgainstTracesOptions
 * @property {number} [timeoutMs=1000] - The timeout in ms.
 * @property {boolean} [rejectFirst=false] - If true, reject the first time the callback throws.
 * @property {RegExp} [spanResourceMatch] - A regex to match against the span resource.
 * @typedef {import('../../src/opentracing/span')} Span
 * For a given payload, an array of traces, each trace is an array of spans.
 * @typedef {(traces: Span[][]) => void} TracesCallback
 * @typedef {(agentlessPayload: {events: Event[]}, request: Request) => void} AgentlessCallback
 * @typedef {TracesCallback | AgentlessCallback} RunCallbackAgainstTracesCallback
 */
/**
 * Register a callback with expectations to be run on every tracing or stats payload sent to the agent depending
 * on the handlers inputted. If the callback does not throw, the returned promise resolves. If it does,
 * then the agent will wait for additional payloads up until the timeout
 * (default 1000 ms) and if any of them succeed, the promise will resolve.
 * Otherwise, it will reject.
 *
 * @param {RunCallbackAgainstTracesCallback} callback - A function that tests a payload as it's received.
 * @param {RunCallbackAgainstTracesOptions} options={} - An options object
 * @param {Set} handlers - Set of handlers to add the callback to.
 * @returns {Promise<void>} A promise resolving if expectations are met
 */
function runCallbackAgainstTraces (callback, options = {}, handlers) {
  let error
  let resolve
  let reject
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  const rejectionTimeout = setTimeout(() => {
    if (error) reject(error)
  }, options.timeoutMs || 1000)

  const handlerPayload = {
    handler,
    spanResourceMatch: options.spanResourceMatch
  }

  /**
   * @type {TracesCallback | AgentlessCallback}
  */
  function handler (...args) {
    // we assert integration name being tagged on all spans (when running integration tests)
    assertIntegrationName(args[0])

    try {
      const result = callback(...args)
      handlers.delete(handlerPayload)
      clearTimeout(rejectionTimeout)
      resolve(result)
    } catch (e) {
      if (/** @type {RunCallbackAgainstTracesOptions} */ (options).rejectFirst) {
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
   * @param {String|String[]} pluginNames - Name or list of names of plugins to load
   * @param {Record<string, unknown>} [config]
   * @param {Record<string, unknown>} [tracerConfig={}]
   * @returns Promise<void>
   */
  /**
   * Load the plugin on the tracer with an optional config and start a mock agent.
   *
   * @overload
   * @param {String[]} pluginNames - Name or list of names of plugins to load
   * @param {Record<string, unknown>[]} config
   * @param {Record<string, unknown>} [tracerConfig={}]
   * @returns Promise<void>
   */
  async load (pluginNames, config, tracerConfig = {}) {
    if (!Array.isArray(pluginNames)) {
      pluginNames = [pluginNames]
    }

    if (!Array.isArray(config)) {
      config = [config]
    }

    currentIntegrationName = getCurrentIntegrationName()

    tracer = require('../..')
    agent = express()
    agent.use(bodyParser.raw({ limit: Infinity, type: 'application/msgpack' }))
    agent.use(bodyParser.text({ limit: Infinity, type: 'application/json' }))
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

    // LLM Observability traces endpoint
    agent.post('/evp_proxy/v2/api/v2/llmobs', (req, res) => {
      llmobsHandlers.forEach(({ handler }) => {
        handler(JSON.parse(req.body))
      })
      res.status(200).send()
    })

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

    /** @type {(this: server, event: string, ...args: unknown[]) => boolean} */
    const originalEmit = emit
    server.emit = function (event, ...args) {
      storage('legacy').enterWith({ noop: true })
      return originalEmit.call(this, event, ...args)
    }

    server.on('connection', socket => sockets.push(socket))

    const promise = /** @type {Promise<void>} */ (new Promise((resolve, _reject) => {
      listener = server.listen(0, () => {
        const port = listener.address().port

        tracer.init(Object.assign({}, {
          service: 'test',
          env: 'tester',
          port,
          flushInterval: 0,
          plugins: false
        }, tracerConfig))

        tracer.setUrl(`http://127.0.0.1:${port}`)

        for (let i = 0, l = pluginNames.length; i < l; i++) {
          tracer.use(pluginNames[i], config[i])
        }

        resolve()
      })
    }))

    plugins = pluginNames

    server.on('close', () => {
      tracer = null
      dsmStats = []
      currentIntegrationName = null
    })

    return promise
  },

  /**
   * @param {string} pluginName
   * @param {Record<string, unknown>} [config]
   */
  reload (pluginName, config) {
    plugins = [pluginName]
    dsmStats = []

    tracer.use(pluginName, config)
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
   * Callback for running test assertions against a span.
   *
   * @callback testAssertionSpanCallback
   * @param {Span} span - For a given payload, the first span of the first trace.
   */

  /**
   * This callback gets executed once for every payload received by the agent.
   * It calls the callback with a `traces` argument which is an array of traces.
   * Each of these traces is an array of spans.
   *
   * @param {RunCallbackAgainstTracesCallback} callback - runs once per agent payload
   * @param {RunCallbackAgainstTracesOptions} [options] - An options object
   * @returns Promise
   */
  assertSomeTraces (callback, options) {
    const startTime = performance.now()
    process._rawDebug('Entered into assertSomeTraces')
    const result = runCallbackAgainstTraces(callback, options, traceHandlers)
    process._rawDebug('Exited assertSomeTraces', performance.now() - startTime, result)
    return result
  },

  /**
   * Same as assertSomeTraces() but only provides the first span (traces[0][0])
   * This callback gets executed once for every payload received by the agent.
   *
   * @param {testAssertionSpanCallback|Record<string|symbol, unknown>} callbackOrExpected - runs once per agent payload
   * @param {RunCallbackAgainstTracesOptions} [options] - An options object
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
   *
   * @param {RunCallbackAgainstTracesCallback} callback - runs once per agent payload
   * @param {RunCallbackAgainstTracesOptions} [options] - An options object
   * @returns Promise
   */
  expectPipelineStats (callback, options) {
    return runCallbackAgainstTraces(callback, options, statsHandlers)
  },

  /**
   * Use a callback handler for LLM Observability traces.
   * @param {RunCallbackAgainstTracesCallback} callback
   * @param {RunCallbackAgainstTracesOptions} [options]
   * @returns
   */
  useLlmobsTraces (callback, options) {
    return runCallbackAgainstTraces(callback, options, llmobsHandlers)
  },

  /**
   * Unregister any outstanding expectation callbacks.
   */
  reset () {
    traceHandlers.clear()
    statsHandlers.clear()
    llmobsHandlers.clear()
  },

  /**
   * Stop the mock agent, reset all expectations and wipe the require cache.
   *
   * Defaults:
   * - ritmReset: true
   * - wipe: false
   *
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
    llmobsHandlers.clear()
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

    tracer.llmobs.disable()

    return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      this.server.on('close', () => {
        this.server = null

        resolve()
      })
    }))
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
      .filter(name => name.includes(basedir) && !exceptions.some(exception => exception.test(name)))
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
