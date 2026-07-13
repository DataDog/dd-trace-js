'use strict'

const assert = require('assert')
const http = require('http')
const util = require('util')
const { setTimeout: wait } = require('timers/promises')

const bodyParser = require('body-parser')
const express = require('express')
const msgpack = require('@msgpack/msgpack')
const semifies = require('semifies')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
const { storage } = require('../../../datadog-core')

// Channel debug patching (loaded via require side-effect when DD_TEST_CHANNEL_DEBUG is set)
if (process.env.DD_TEST_CHANNEL_DEBUG) require('../debug/channel-patch')

// Modules that close over the previous `Config` / `TracerProxy` singletons.
// Evicted whenever `agent.load`'s gate decides the tracer must rebuild.
// `datadog-instrumentations/*` and `plugin_manager.js` stay cached so RITM
// hooks live for the whole process — see `agent.spec.js` for the regression
// that pins the single-evaluation invariant.
const RELOAD_EVICTION_IDS = [
  '../../../..', // root index.js → `module.exports = require('./packages/dd-trace')`
  '../..',
  '../../src',
  '../../src/proxy',
  '../../src/config',
  '../../src/config/defaults',
  '../../src/serverless',
]

const traceHandlers = new Set()
const statsHandlers = new Set()
let llmobsSpanEventsRequests = []
let llmobsEvaluationMetricsRequests = []
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
let loaded = false

// Non-prefix env vars `dd-trace` reads at module load or in instrumentation
// hot paths. Every non-`DD_*` / non-`OTEL_*` / non-`_DD_*` env read via
// `getEnvironmentVariable`, `getValueFromEnvSources`, or a destructured
// `getEnvironmentVariables(...)` in `src/` is registered here so the gate
// below rebuilds the tracer when a spec mocks the value between two
// `agent.load()` calls. The `eslint-non-prefix-env-names` rule extracts
// this Set at lint time and reports new reads that bypass it.
const TRACKED_NON_PREFIX_ENV_NAMES = new Set([
  // serverless / IS_SERVERLESS detection
  'AWS_LAMBDA_FUNCTION_NAME',
  'FUNCTION_NAME',
  'FUNCTION_TARGET',
  'FUNCTIONS_EXTENSION_VERSION',
  'FUNCTIONS_WORKER_RUNTIME',
  'GCP_PROJECT',
  'K_SERVICE',
  'WEBSITE_SKU',
  // lambda RITM target path (computed once at module load)
  'LAMBDA_TASK_ROOT',
  // serverless service-name fallbacks (Config singleton)
  'WEBSITE_SITE_NAME',
  // azure metadata payload (cached at first build)
  'COMPUTERNAME',
  'FUNCTIONS_WORKER_RUNTIME_VERSION',
  'WEBSITE_INSTANCE_ID',
  'WEBSITE_OWNER_NAME',
  'WEBSITE_OS',
  'WEBSITE_RESOURCE_GROUP',
  // CI-visibility runner detection (test plugins, ci-visibility exporters)
  'CUCUMBER_WORKER_ID',
  'JEST_WORKER_ID',
  'MOCHA_WORKER_ID',
  'TINYPOOL_WORKER_ID',
  'npm_config_user_agent',
  'npm_lifecycle_script',
  // GitHub Actions CI plugin metadata
  'GITHUB_EVENT_PATH',
  'RUNNER_TEMP',
  // misc CI provider / build tooling reads
  'HOME',
  'LAGE_PACKAGE_NAME',
  'NX_TASK_TARGET_PROJECT',
  'NYC_CONFIG',
  // instrumentation reads at module load / hot path
  'DATABASE_URL',
  'NODE_OPTIONS',
  'UV_THREADPOOL_SIZE',
])

/**
 * @param {string} key
 */
function isTrackedEnvKey (key) {
  return key.startsWith('DD_') ||
    key.startsWith('OTEL_') ||
    key.startsWith('_DD_') ||
    TRACKED_NON_PREFIX_ENV_NAMES.has(key)
}

/**
 * @returns {Record<string, string | undefined>}
 */
function captureEnvSnapshot () {
  const snapshot = Object.create(null)
  for (const [key, value] of Object.entries(process.env)) {
    if (isTrackedEnvKey(key)) {
      snapshot[key] = value
    }
  }
  return snapshot
}

/**
 * @param {Record<string, string | undefined>} snapshot
 */
function envChangedSince (snapshot) {
  const seen = new Set()
  for (const [key, value] of Object.entries(process.env)) {
    if (isTrackedEnvKey(key)) {
      if (snapshot[key] !== value) return true
      seen.add(key)
    }
  }
  for (const key of Object.keys(snapshot)) {
    if (!seen.has(key)) return true
  }
  return false
}

// Captured at agent.js evaluation, before any `before` hook runs.
let envSnapshot = captureEnvSnapshot()
// Stored as a JSON snapshot rather than a reference: a spec that keeps the
// same `tracerConfig` object alive and mutates it between two `agent.load`
// calls would otherwise hand the gate `same === same` and skip the rebuild
// even though the values changed.
let lastTracerConfigJson = '{}'

/** @type {Map<string, Record<string, unknown> | undefined>} */
const loadedPlugins = new Map()

function isMatchingTrace (spans, spanResourceMatch) {
  if (!spanResourceMatch) {
    return true
  }
  return !!spans.find(span => spanResourceMatch.test(span.resource))
}

/**
 * Pick the span an `assertFirstTraceSpan` assertion runs against. With a
 * `spanResourceMatch` the first span whose resource matches wins, so callers can
 * target a nested child (e.g. a per-command write under a `bulkWrite` parent)
 * without it having to be `traces[0][0]`. Without a matcher the first span of the
 * first trace is used.
 *
 * @param {import('../../src/opentracing/span')[][]} traces
 * @param {RegExp} [spanResourceMatch]
 * @returns {import('../../src/opentracing/span')}
 */
function findFirstTraceSpan (traces, spanResourceMatch) {
  if (spanResourceMatch) {
    for (const trace of traces) {
      for (const span of trace) {
        if (spanResourceMatch.test(span.resource)) {
          return span
        }
      }
    }
  }
  return traces[0][0]
}

function ciVisRequestHandler (request, response) {
  response.status(200).send('OK')
  for (const { handler, spanResourceMatch } of traceHandlers) {
    const { events } = request.body
    const spans = events.map(event => event.content)
    if (isMatchingTrace(spans, spanResourceMatch)) {
      handler(request.body, request)
    }
  }
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
  if (span.meta?.events) {
    // Parse the JSON string back into an object
    const events = JSON.parse(span.meta.events)

    // Create the _events array
    return events.map(event => {
      return {
        name: event.name,
        startTime: event.time_unix_nano / 1e6, // Convert from nanoseconds back to milliseconds
        attributes: event.attributes ? event.attributes : undefined,
      }
    })
  }

  return [] // Return an empty array if no events are found
}

/**
 * @param {express.Request} req
 * @param {express.Response} res
 */
function handleTraceRequest (req, res) {
  res.status(200).send({ rate_by_service: { 'service:,env:': 1 } })
  for (const { handler, spanResourceMatch } of traceHandlers) {
    const trace = req.body
    const spans = trace.flatMap(span => span)
    if (isMatchingTrace(spans, spanResourceMatch)) {
      handler(trace)
    }
  }
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
              assert.strictEqual(span.meta['_dd.integration'],
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
 * @typedef {object} RunCallbackAgainstTracesOptions
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
 * @param {RunCallbackAgainstTracesOptions} options = {} - An options object
 * @param {Set} handlers - Set of handlers to add the callback to.
 * @returns {Promise<void>} A promise resolving if expectations are met
 */
function runCallbackAgainstTraces (callback, options = {}, handlers) {
  /** @type {Error[]} */
  const errors = []
  let resolve
  let reject
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  const rejectionTimeout = setTimeout(() => {
    if (errors.length) {
      let error = errors[0]
      if (errors.length > 1) {
        error = new AggregateError(errors, 'Asserting traces failed. No result matched the expected one.')
        // Mark errors enumerable for older Node.js versions to be visible.
        Object.defineProperty(error, 'errors', {
          enumerable: true,
        })
      }
      // Hack for the information to be fully visible.
      error.message = util.inspect(error, { depth: null })
      reject(error)
    }
  }, options.timeoutMs || 1000)

  const handlerPayload = {
    handler,
    spanResourceMatch: options.spanResourceMatch,
  }

  /**
   * @type {TracesCallback | AgentlessCallback}
   */
  function handler (...args) {
    // we assert integration name being tagged on all spans (when running integration tests)
    assertIntegrationName(args[0])

    try {
      // @ts-expect-error The number of arguments can either be one or two. TS expects it to be stricter typed.
      const result = callback(...args)
      handlers.delete(handlerPayload)
      clearTimeout(rejectionTimeout)
      resolve(result)
    } catch (error) {
      if (/** @type {RunCallbackAgainstTracesOptions} */ (options).rejectFirst) {
        clearTimeout(rejectionTimeout)
        reject(error)
      } else {
        errors.push(error)
      }
    }
  }

  handler.promise = promise
  handlers.add(handlerPayload)

  return promise
}

module.exports = {
  /**
   * Load the plugin on the tracer with an optional config and start a
   * mock agent. The returned promise resolves with the live
   * `TracerProxy`; specs should bind `tracer` from this return value
   * rather than capturing `require('../../dd-trace')` themselves, since
   * the gate-fired rebuild path evicts `dd-trace` from `require.cache`
   * and rebinds `global._ddtrace`.
   *
   * @overload
   * @param {string | string[]} pluginNames
   * @param {Record<string, unknown>} [config]
   * @param {Record<string, unknown>} [tracerConfig]
   * @returns {Promise<import('../../..').default>}
   */
  /**
   * @overload
   * @param {string[]} pluginNames
   * @param {Record<string, unknown>[]} config
   * @param {Record<string, unknown>} [tracerConfig]
   * @returns {Promise<import('../../..').default>}
   */
  async load (pluginNames, config, tracerConfig = {}) {
    if (!Array.isArray(pluginNames)) {
      pluginNames = [pluginNames]
    }

    if (!Array.isArray(config)) {
      config = [config]
    }

    currentIntegrationName = getCurrentIntegrationName()

    const tracerConfigJson = JSON.stringify(tracerConfig)
    if (
      !loaded ||
      global._ddtrace === undefined ||
      envChangedSince(envSnapshot) ||
      lastTracerConfigJson !== tracerConfigJson
    ) {
      if (global._ddtrace !== undefined) {
        global._ddtrace._pluginManager.destroy()
      }
      // Filter `mainBeforeExit` by name rather than calling
      // `process.removeAllListeners`: nyc registers a coverage-flush
      // listener on the same events, and dropping it leaves coverage
      // unwritten and, after enough rebuilds, hangs the next test.
      const ddTraceSymbol = Symbol.for('dd-trace')
      globalThis[ddTraceSymbol]?.beforeExitHandlers?.clear()
      for (const event of ['exit', 'beforeExit']) {
        for (const listener of process.listeners(event)) {
          if (listener.name === 'mainBeforeExit') {
            process.removeListener(event, listener)
          }
        }
      }
      delete global._ddtrace

      for (const id of RELOAD_EVICTION_IDS) {
        delete require.cache[require.resolve(id)]
      }

      tracer = require('../..')
      envSnapshot = captureEnvSnapshot()
      lastTracerConfigJson = tracerConfigJson
      loaded = true
    } else {
      tracer = require('../..')
    }

    for (let i = 0; i < pluginNames.length; i++) {
      loadedPlugins.set(pluginNames[i], config[i])
    }

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

    // This is a workaround to ensure that the agent is ready to receive
    // requests without being cleaned up properly.
    // TODO: Fix the root cause.
    const innerAgent = agent

    await wait(1)

    if (agent !== innerAgent) {
      throw new Error('Agent got replaced since last load')
    }

    agent.get('/info', (req, res) => {
      res.status(202).send({
        endpoints: availableEndpoints,
      })
    })

    agent.put('/v0.5/traces', (req, res) => {
      res.status(404).end()
    })

    agent.put('/v0.4/traces', handleTraceRequest)
    agent.post('/api/v2/citestcycle', ciVisRequestHandler)
    agent.post('/evp_proxy/v2/api/v2/citestcycle', ciVisRequestHandler)

    agent.post('/evp_proxy/v2/api/v2/llmobs', (req, res) => {
      llmobsSpanEventsRequests.push(JSON.parse(req.body))
      res.status(200).send()
    })

    agent.post('/evp_proxy/v2/api/intake/llm-obs/v2/eval-metric', (req, res) => {
      llmobsEvaluationMetricsRequests.push(JSON.parse(req.body))
      res.status(200).send()
    })

    dsmStats = []
    agent.post('/v0.1/pipeline_stats', (req, res) => {
      dsmStats.push(req.body)
      for (const { handler } of statsHandlers) {
        handler(dsmStats)
      }
      res.status(200).send()
    })

    const server = this.server = http.createServer(agent)
    const emit = server.emit

    /** @type {(this: server, event: string, ...args: unknown[]) => boolean} */
    const originalEmit = emit
    server.emit = function (event, ...args) {
      return storage('legacy').run({ noop: true }, () => originalEmit.call(this, event, ...args))
    }

    server.on('connection', socket => sockets.push(socket))

    const promise = /** @type {Promise<import('../../..').default>} */ (new Promise((resolve, _reject) => {
      listener = server.listen(0, () => {
        const port = this.port = listener.address().port

        tracer.init({
          service: 'test',
          env: 'tester',
          port,
          flushInterval: 0,
          plugins: false,
          ...tracerConfig,
        })

        tracer.setUrl(`http://127.0.0.1:${port}`)

        for (const [name, pluginConfig] of loadedPlugins) {
          tracer.use(name, pluginConfig)
        }

        resolve(tracer)
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
    traceHandlers.add({ handler })
  },

  /**
   * Remove a handler
   * @param {Function} handler
   */
  unsubscribe (handler) {
    for (const traceHandler of traceHandlers) {
      if (traceHandler.handler === handler) {
        traceHandlers.delete(traceHandler)
      }
    }
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
    return runCallbackAgainstTraces(callback, options, traceHandlers)
  },

  /**
   * Same as assertSomeTraces() but only provides a single span. By default that
   * is the first span of the first trace (traces[0][0]); pass a
   * `spanResourceMatch` in the options to target the first span whose resource
   * matches it instead, which lets a nested child span (e.g. a per-command write
   * under a `bulkWrite` parent) be asserted without being traces[0][0].
   * This callback gets executed once for every payload received by the agent.
   *
   * @param {testAssertionSpanCallback|Record<string|symbol, unknown>} callbackOrExpected - runs once per agent payload
   * @param {RunCallbackAgainstTracesOptions} [options] - An options object
   * @returns Promise
   */
  assertFirstTraceSpan (callbackOrExpected, options) {
    return runCallbackAgainstTraces(function (traces) {
      const span = findFirstTraceSpan(traces, options?.spanResourceMatch)
      if (typeof callbackOrExpected !== 'function') {
        try {
          assertObjectContains(span, callbackOrExpected)
        } catch (error) {
          // Enrich error with actual and expected traces for Node.js < 22.17.0
          if (semifies(process.version, '<22.17.0')) {
            error.actualTraces = util.inspect(traces, { depth: null })
            error.expectedTraces = util.inspect(callbackOrExpected, { depth: null })
          }
          throw error
        }
      } else {
        return callbackOrExpected(span)
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
   * Get the LLM Observability span events requests.
   * @param {boolean} clear - Clear the requests after getting them.
   * @returns {Array<object>} The LLM Observability span events requests.
   */
  getLlmObsSpanEventsRequests (clear = false) {
    const requests = llmobsSpanEventsRequests
    if (clear) {
      llmobsSpanEventsRequests = []
    }

    return requests
  },

  /**
   * Get the LLM Observability evaluation metrics requests.
   * @param {boolean} clear - Clear the requests after getting them.
   * @returns {Array<object>} The LLM Observability evaluation metrics requests.
   */
  getLlmObsEvaluationMetricsRequests (clear = false) {
    const requests = llmobsEvaluationMetricsRequests
    if (clear) {
      llmobsEvaluationMetricsRequests = []
    }

    return requests
  },

  /**
   * Framework-only — called from `packages/dd-trace/test/setup/mocha.js`'s
   * global `afterEach` to drop every test's outstanding expectation
   * callbacks before the next test runs. Tests should never call this:
   * `agent.close` already covers per-suite teardown, and per-test
   * expectations are scoped to whichever assertion helper added them.
   */
  reset () {
    traceHandlers.clear()
    statsHandlers.clear()
    llmobsSpanEventsRequests = []
    llmobsEvaluationMetricsRequests = []
  },

  /**
   * Tear down the mock agent and reset every per-test expectation. Idempotent.
   * The next `agent.load` decides for itself whether to reuse the cached
   * tracer or rebuild it; tests do not pass options here.
   */
  close () {
    if (listener === null) {
      return Promise.resolve()
    }

    listener.close()
    listener = null
    for (const socket of sockets) {
      socket.end()
    }
    sockets = []
    agent = null
    traceHandlers.clear()
    statsHandlers.clear()
    llmobsSpanEventsRequests = []
    llmobsEvaluationMetricsRequests = []
    for (const plugin of plugins) {
      tracer.use(plugin, { enabled: false })
    }
    loadedPlugins.clear()
    // Force the next `agent.load` through the gate-fired rebuild path
    // so cross-file leaks (`code_origin` tags sticking across files,
    // `router`'s path-stack accumulating, …) cannot silently inherit
    // the previous file's `Config` when both load with default
    // `tracerConfig: {}`.
    loaded = false
    this.setAvailableEndpoints(DEFAULT_AVAILABLE_ENDPOINTS)
    currentIntegrationName = null

    tracer.llmobs.disable()

    return /** @type {Promise<void>} */ (new Promise(resolve => {
      this.server.on('close', () => {
        this.server = null
        this.port = null

        resolve()
      })
    }))
  },

  setAvailableEndpoints (newEndpoints) {
    availableEndpoints = newEndpoints
  },

  tracer,
  testedPlugins,
  getDsmStats,
  dsmStatsExist,
  dsmStatsExistWithParentHash,
  unformatSpanEvents,
}
