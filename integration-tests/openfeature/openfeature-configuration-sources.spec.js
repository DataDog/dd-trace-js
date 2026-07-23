'use strict'

const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const http = require('node:http')
const path = require('node:path')
const zlib = require('node:zlib')
const { after, before, describe, it } = require('mocha')

const { ACKNOWLEDGED } = require('../../packages/dd-trace/src/remote_config/apply_states')
const { VERSION } = require('../../version')
const { FakeAgent, sandboxCwd, spawnProc, stopProc, useSandbox } = require('../helpers')

const AGENTLESS_PATH = '/api/v2/feature-flagging/config/rules-based/server'
const AGENTLESS_SPAN = 'configuration-source.agentless-poll'
const APPLICATION_SPAN = 'configuration-source.before-access'
const COMMAND_TIMEOUT_MS = 5_000
const DEFAULT_VALUE = 'configuration-source-default'
const EXPECTED_VALUE = 'configuration-source-loaded'
const FLAG_KEY = 'configuration-source-flag'
const OBSERVATION_TIMEOUT_MS = 3_000
const RC_CONFIG_ID = 'configuration-source-contract'
const RC_PRODUCT = 'FFE_FLAGS'
const TARGETING_KEY = '12345'
const WORKER_COUNT = 7

const BOOLEAN_SETTINGS = ['absent', 'true', 'false']
const SOURCE_SETTINGS = [
  { name: 'absent' },
  { name: 'empty', value: '' },
  { name: 'whitespace', value: '   ' },
  { name: 'agentless', value: 'agentless' },
  { name: 'remote_config', value: 'remote_config' },
  { name: 'offline', value: 'offline' },
  { name: 'invalid', value: 'unsupported' },
]

const CONFIGURATION = {
  createdAt: '2026-01-01T00:00:00.000Z',
  format: 'SERVER',
  environment: { name: 'integration' },
  flags: {
    [FLAG_KEY]: {
      key: FLAG_KEY,
      enabled: true,
      variationType: 'STRING',
      variations: {
        selected: { key: 'selected', value: EXPECTED_VALUE },
      },
      allocations: [{
        key: 'configuration-source-allocation',
        rules: [],
        splits: [{ variationKey: 'selected', shards: [] }],
      }],
    },
  },
}

const AGENTLESS_RESPONSE = zlib.gzipSync(JSON.stringify({
  data: {
    id: RC_CONFIG_ID,
    type: 'universal-flag-configuration',
    attributes: CONFIGURATION,
  },
}))

/** @typedef {'absent'|'true'|'false'} BooleanSetting */
/** @typedef {'agentless'|'remote_config'|'disabled'} Delivery */
/** @typedef {{ name: string, value?: string }} SourceSetting */
/**
 * @typedef {object} ConfigurationCase
 * @property {string} identifier
 * @property {string} label
 * @property {string} service
 * @property {BooleanSetting} stable
 * @property {SourceSetting} source
 * @property {BooleanSetting} legacy
 * @property {Delivery} expected
 */

const configurationCases = buildConfigurationCases()
const observations = new EventEmitter()
const accessedCases = new Set()
const agentlessRequests = new Map()
const applicationRequests = new Map()
const remoteConfigRequests = new Map()
const spansByService = new Map()
const observedSpans = []

let agent
let appFile
let backend
let backendUrl
let cwd

describe('OpenFeature configuration source contract', () => {
  useSandbox(
    ['@openfeature/server-sdk', '@openfeature/core'],
    false,
    [path.join(__dirname, 'app')]
  )

  before(async () => {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'app', 'configuration-source-evaluation.js')
    agent = new FakeAgent()
    backend = http.createServer(handleBackendRequest)

    const backendListening = once(backend, 'listening')
    backend.listen(0, '127.0.0.1')
    await Promise.all([agent.start(), backendListening])

    backendUrl = `http://127.0.0.1:${backend.address().port}`
    agent.addRemoteConfig({
      product: RC_PRODUCT,
      id: RC_CONFIG_ID,
      config: CONFIGURATION,
    })
    agent.on('message', recordTraceMessage)
    agent.on('remote-config-request', recordRemoteConfigRequest)
  })

  after(async () => {
    const agentStopped = agent?.stop()
    let backendStopped
    if (backend?.listening) {
      backendStopped = once(backend, 'close')
      backend.close()
    }
    await Promise.all([agentStopped, backendStopped])
  })

  it('covers all 63 stable/source/legacy combinations without tracing CDN polling', async function () {
    this.timeout(60_000)

    assert.strictEqual(configurationCases.length, 63)
    assert.deepStrictEqual(countDeliveries(configurationCases), {
      agentless: 12,
      remote_config: 12,
      disabled: 39,
    })

    await runCases(configurationCases)

    const selfTraces = []
    for (const span of observedSpans) {
      if (isAgentlessHttpSpan(span)) selfTraces.push(span)
    }
    assert.deepStrictEqual(selfTraces, [])
  })
})

/**
 * @param {ConfigurationCase[]} cases
 */
async function runCases (cases) {
  const errors = []
  const workers = []
  for (let i = 0; i < WORKER_COUNT; i++) {
    workers.push(runCaseRange(cases, i, WORKER_COUNT, errors))
  }
  await Promise.all(workers)
  if (errors.length > 0) {
    throw new AggregateError(errors, formatCaseFailures(errors))
  }
}

/**
 * @param {Error[]} errors
 */
function formatCaseFailures (errors) {
  const lines = [`${errors.length} configuration source cases failed:`]
  for (const error of errors) {
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
    lines.push(`${error.message}: ${cause}`)
  }
  return lines.join('\n')
}

/**
 * @param {ConfigurationCase[]} cases
 * @param {number} offset
 * @param {number} stride
 * @param {Error[]} errors
 */
async function runCaseRange (cases, offset, stride, errors) {
  for (let i = offset; i < cases.length; i += stride) {
    try {
      await runCase(cases[i])
    } catch (error) {
      errors.push(new Error(cases[i].label, { cause: error }))
    }
  }
}

/**
 * @param {ConfigurationCase} testCase
 */
async function runCase (testCase) {
  let proc
  try {
    proc = await spawnProc(appFile, {
      cwd,
      env: buildEnvironment(testCase),
      silent: true,
    })

    const startupRemoteConfig = waitForObservation(
      remoteConfigRequests,
      testCase.service,
      'remote-config',
      hasObservation
    )
    await Promise.all([
      startupRemoteConfig,
      waitForSpan(testCase.service, APPLICATION_SPAN),
      sendCommand(proc, { command: 'trace', spanName: APPLICATION_SPAN }),
    ])

    assert.strictEqual(requestsFor(agentlessRequests, testCase.identifier).length, 0, testCase.label)
    assertStartupRemoteConfig(testCase)

    if (testCase.expected === 'remote_config') {
      await waitForObservation(
        remoteConfigRequests,
        testCase.service,
        'remote-config',
        hasConfigurationAcknowledgment
      )
    }

    const remoteConfigStartIndex = requestsFor(remoteConfigRequests, testCase.service).length
    accessedCases.add(testCase.identifier)
    const accessCommand = {
      command: 'access',
      waitForReady: testCase.expected !== 'disabled',
    }

    if (testCase.expected === 'agentless') {
      await Promise.all([
        waitForObservation(agentlessRequests, testCase.identifier, 'agentless', hasObservation),
        sendCommand(proc, accessCommand),
      ])
    } else {
      await sendCommand(proc, accessCommand)
    }

    const { details } = await sendCommand(proc, { command: 'evaluate' })
    assertEvaluation(testCase, details)

    await waitForObservation(
      remoteConfigRequests,
      testCase.service,
      'remote-config',
      hasObservation,
      remoteConfigStartIndex
    )

    if (testCase.expected === 'agentless') {
      await traceDeliberateRequest(proc, testCase)
    }

    assertDeliveryTraffic(testCase)
  } finally {
    await stopProc(proc)
  }
}

/**
 * @param {import('node:child_process').ChildProcess} proc
 * @param {ConfigurationCase} testCase
 */
async function traceDeliberateRequest (proc, testCase) {
  const spanStartIndex = requestsFor(spansByService, testCase.service).length
  const requestStartIndex = requestsFor(applicationRequests, testCase.identifier).length
  const url = `${backendUrl}/deliberate/${testCase.identifier}`

  await Promise.all([
    waitForSpan(testCase.service, AGENTLESS_SPAN, spanStartIndex),
    waitForObservation(
      applicationRequests,
      testCase.identifier,
      'application-request',
      hasObservation,
      requestStartIndex
    ),
    sendCommand(proc, { command: 'trace', spanName: AGENTLESS_SPAN, url }),
  ])

  let deliberateHttpSpan
  for (const span of observedSpans) {
    if (isDeliberateHttpSpan(span, testCase.identifier)) {
      deliberateHttpSpan = span
      break
    }
  }
  assert.ok(deliberateHttpSpan, `${testCase.label}: deliberate fetch was not traced`)

  const selfTraces = []
  for (const span of observedSpans) {
    if (isAgentlessHttpSpan(span)) selfTraces.push(span)
  }
  assert.deepStrictEqual(selfTraces, [], testCase.label)
}

/**
 * @param {ConfigurationCase} testCase
 * @param {object} details
 */
function assertEvaluation (testCase, details) {
  const expectedValue = testCase.expected === 'disabled' ? DEFAULT_VALUE : EXPECTED_VALUE
  assert.strictEqual(details.value, expectedValue, testCase.label)
  if (testCase.expected !== 'disabled') {
    assert.notStrictEqual(details.reason, 'ERROR', testCase.label)
  }
}

/**
 * @param {ConfigurationCase} testCase
 */
function assertStartupRemoteConfig (testCase) {
  const requests = requestsFor(remoteConfigRequests, testCase.service)
  if (testCase.expected === 'remote_config') {
    assert.ok(requests.some(hasFfeProduct), testCase.label)
  } else {
    assert.ok(requests.every(withoutFfeProduct), testCase.label)
  }
}

/**
 * @param {ConfigurationCase} testCase
 */
function assertDeliveryTraffic (testCase) {
  const cdnRequests = requestsFor(agentlessRequests, testCase.identifier)
  const rcRequests = requestsFor(remoteConfigRequests, testCase.service)

  if (testCase.expected === 'agentless') {
    assert.ok(cdnRequests.length >= 1, testCase.label)
    assert.ok(cdnRequests.every(wasAfterAccess), testCase.label)
    assert.ok(rcRequests.every(withoutFfeProduct), testCase.label)
    for (const request of cdnRequests) {
      assert.strictEqual(request.url, `${AGENTLESS_PATH}?case=${testCase.identifier}`, testCase.label)
      assert.strictEqual(request.headers['accept-encoding'], 'gzip', testCase.label)
      assert.strictEqual(request.headers['dd-api-key'], undefined, testCase.label)
      assert.strictEqual(request.headers['dd-client-library-language'], 'nodejs', testCase.label)
      assert.strictEqual(request.headers['dd-client-library-version'], VERSION, testCase.label)
    }
    return
  }

  assert.strictEqual(cdnRequests.length, 0, testCase.label)
  if (testCase.expected === 'remote_config') {
    assert.ok(rcRequests.some(hasFfeProduct), testCase.label)
  } else {
    assert.ok(rcRequests.every(withoutFfeProduct), testCase.label)
  }
}

/**
 * @param {ConfigurationCase} testCase
 */
function buildEnvironment (testCase) {
  const env = {
    DD_API_KEY: 'integration-api-key',
    DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL:
      `${backendUrl}/?case=${testCase.identifier}`,
    DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS: '30',
    DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_REQUEST_TIMEOUT_SECONDS: '1',
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
    DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: '0.05',
    DD_TRACE_AGENT_HOSTNAME: '127.0.0.1',
    DD_TRACE_AGENT_PORT: String(agent.port),
    DD_TRACE_STARTUP_LOGS: 'false',
    TEST_DEFAULT_VALUE: DEFAULT_VALUE,
    TEST_FLAG_KEY: FLAG_KEY,
    TEST_SERVICE: testCase.service,
    TEST_TARGETING_KEY: TARGETING_KEY,
  }

  setBooleanEnvironment(env, 'DD_FEATURE_FLAGS_ENABLED', testCase.stable)
  setBooleanEnvironment(env, 'DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED', testCase.legacy)
  if (Object.hasOwn(testCase.source, 'value')) {
    env.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = testCase.source.value
  }
  return env
}

/**
 * @param {Record<string, string>} env
 * @param {string} name
 * @param {BooleanSetting} setting
 */
function setBooleanEnvironment (env, name, setting) {
  if (setting !== 'absent') env[name] = setting
}

/**
 * @param {import('node:child_process').ChildProcess} proc
 * @param {object} command
 * @param {'access'|'evaluate'|'trace'} command.command
 * @param {string} [command.spanName]
 * @param {string} [command.url]
 * @param {boolean} [command.waitForReady]
 */
async function sendCommand (proc, command) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS)
  try {
    const response = once(proc, 'message', { signal: controller.signal })
    proc.send(command)
    const [message] = await response
    if (message.error) throw new Error(message.error)
    return message
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Timed out waiting for child command ${command.command}`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * @param {string} service
 * @param {string} spanName
 * @param {number} [startIndex]
 */
function waitForSpan (service, spanName, startIndex = 0) {
  /**
   * @param {object} span
   */
  function hasSpanName (span) {
    return span.name === spanName
  }

  return waitForObservation(spansByService, service, 'span', hasSpanName, startIndex)
}

/**
 * @param {Map<string, object[]>} collection
 * @param {string} key
 * @param {string} eventName
 * @param {(value: object) => boolean} predicate
 * @param {number} [startIndex]
 */
function waitForObservation (collection, key, eventName, predicate, startIndex = 0) {
  const current = findObservation(requestsFor(collection, key), predicate, startIndex)
  if (current !== undefined) return Promise.resolve(current)
  const observationEvent = `${eventName}:${key}`

  /**
   * @param {(value: object) => void} resolve
   * @param {(error: Error) => void} reject
   */
  function observe (resolve, reject) {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${eventName} observation for ${key}`))
    }, OBSERVATION_TIMEOUT_MS)

    /**
     * @param {string} observedKey
     */
    function handleObservation (observedKey) {
      if (observedKey !== key) return
      const match = findObservation(requestsFor(collection, key), predicate, startIndex)
      if (match === undefined) return
      cleanup()
      resolve(match)
    }

    function cleanup () {
      clearTimeout(timeout)
      observations.removeListener(observationEvent, handleObservation)
    }

    observations.on(observationEvent, handleObservation)
  }

  return new Promise(observe)
}

/**
 * @param {object[]} values
 * @param {(value: object) => boolean} predicate
 * @param {number} startIndex
 */
function findObservation (values, predicate, startIndex) {
  for (let i = startIndex; i < values.length; i++) {
    if (predicate(values[i])) return values[i]
  }
}

/**
 * @param {Map<string, object[]>} collection
 * @param {string} key
 */
function requestsFor (collection, key) {
  return collection.get(key) ?? []
}

/**
 * @param {Map<string, object[]>} collection
 * @param {string} key
 * @param {string} eventName
 * @param {object} value
 */
function recordObservation (collection, key, eventName, value) {
  let values = collection.get(key)
  if (!values) {
    values = []
    collection.set(key, values)
  }
  values.push(value)
  observations.emit(`${eventName}:${key}`, key)
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
function handleBackendRequest (request, response) {
  const url = new URL(request.url, 'http://127.0.0.1')
  let identifier = url.searchParams.get('case')
  if (url.pathname.startsWith('/deliberate/')) {
    identifier = url.pathname.slice('/deliberate/'.length)
    recordObservation(applicationRequests, identifier, 'application-request', {
      headers: request.headers,
      url: request.url,
    })
    response.writeHead(204, { Connection: 'close' }).end()
    return
  }

  if (url.pathname !== AGENTLESS_PATH || identifier === null) {
    response.writeHead(404, { Connection: 'close' }).end()
    return
  }

  recordObservation(agentlessRequests, identifier, 'agentless', {
    afterAccess: accessedCases.has(identifier),
    headers: request.headers,
    url: request.url,
  })
  response.writeHead(200, {
    Connection: 'close',
    'Content-Encoding': 'gzip',
    'Content-Type': 'application/json',
  })
  response.end(AGENTLESS_RESPONSE)
}

/**
 * @param {object} request
 */
function recordRemoteConfigRequest (request) {
  const service = request.client?.client_tracer?.service
  if (typeof service === 'string') {
    recordObservation(remoteConfigRequests, service, 'remote-config', request)
  }
}

/**
 * @param {object} message
 * @param {object[][]} message.payload
 */
function recordTraceMessage ({ payload }) {
  if (!Array.isArray(payload)) return
  for (const trace of payload) {
    if (!Array.isArray(trace)) continue
    for (const span of trace) {
      observedSpans.push(span)
      if (typeof span.service === 'string') {
        recordObservation(spansByService, span.service, 'span', span)
      }
    }
  }
}

/**
 * @param {object} request
 */
function hasFfeProduct (request) {
  return request.client?.products?.includes(RC_PRODUCT) === true
}

/**
 * @param {object} request
 */
function withoutFfeProduct (request) {
  return !hasFfeProduct(request)
}

/**
 * @param {object} request
 */
function hasConfigurationAcknowledgment (request) {
  const states = request.client?.state?.config_states
  if (!Array.isArray(states)) return false
  for (const state of states) {
    if (state.id === RC_CONFIG_ID && state.apply_state === ACKNOWLEDGED) return true
  }
  return false
}

function hasObservation () {
  return true
}

/**
 * @param {object} request
 */
function wasAfterAccess (request) {
  return request.afterAccess === true
}

/**
 * @param {object} span
 */
function isAgentlessHttpSpan (span) {
  return span.name === 'http.request' && span.meta?.['http.url']?.includes(AGENTLESS_PATH) === true
}

/**
 * @param {object} span
 * @param {string} identifier
 */
function isDeliberateHttpSpan (span, identifier) {
  return span.name === 'http.request' &&
    span.meta?.['http.url']?.includes(`/deliberate/${identifier}`) === true
}

/**
 * @param {ConfigurationCase[]} cases
 */
function countDeliveries (cases) {
  const counts = {
    agentless: 0,
    remote_config: 0,
    disabled: 0,
  }
  for (const testCase of cases) counts[testCase.expected]++
  return counts
}

function buildConfigurationCases () {
  const cases = []
  let caseNumber = 0
  for (const stable of BOOLEAN_SETTINGS) {
    for (const source of SOURCE_SETTINGS) {
      for (const legacy of BOOLEAN_SETTINGS) {
        const expected = expectedDelivery(stable, source, legacy)
        const identifier = String(caseNumber++)
        cases.push({
          identifier,
          label: `stable=${stable}, source=${source.name}, legacy=${legacy} -> ${expected}`,
          service: `configuration-source-${identifier}`,
          stable,
          source,
          legacy,
          expected,
        })
      }
    }
  }
  return cases
}

/**
 * @param {BooleanSetting} stable
 * @param {SourceSetting} source
 * @param {BooleanSetting} legacy
 * @returns {Delivery}
 */
function expectedDelivery (stable, source, legacy) {
  if (stable === 'false') return 'disabled'
  if (source.name === 'agentless') return 'agentless'
  if (source.name === 'remote_config') return 'remote_config'
  if (source.name === 'offline' || source.name === 'invalid') return 'disabled'
  if (legacy === 'true') return 'remote_config'
  if (legacy === 'false') return 'disabled'
  return 'agentless'
}
