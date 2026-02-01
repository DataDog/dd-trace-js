'use strict'

const assert = require('assert')
const os = require('os')
const { basename, join } = require('path')
const { readFileSync } = require('fs')
const { randomUUID } = require('crypto')

const Axios = require('axios')

const { assertObjectContains, assertUUID } = require('../helpers')
const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../helpers')
const { generateProbeConfig } = require('../../packages/dd-trace/test/debugger/devtools_client/utils')
const { version } = require('../../package.json')

const BREAKPOINT_TOKEN = '// BREAKPOINT'
const pollInterval = 0.1

/**
 * @typedef {import('../../packages/dd-trace/test/debugger/devtools_client/utils').ProbeConfig} ProbeConfig
 */

/**
 * @typedef {typeof import('../../packages/dd-trace/test/debugger/devtools_client/utils').generateProbeConfig}
 *   GenerateProbeConfigFn
 */

/**
 * Bound version of generateProbeConfig that only requires optional overrides (breakpoint is already bound).
 *
 * @typedef {(overrides?: Partial<ProbeConfig>) => ProbeConfig} BoundGenerateProbeConfigFn
 */

/**
 * @typedef {object} BreakpointInfo
 * @property {string} sourceFile
 * @property {string} deployedFile
 * @property {number} line
 * @property {string} url
 */

/**
 * A breakpoint with helpers bound for convenient testing.
 *
 * @typedef {BreakpointInfo & {
 *   rcConfig: object|null,
 *   triggerBreakpoint: () => Promise<import('axios').AxiosResponse<unknown>>,
 *   generateRemoteConfig: (overrides?: object) => object,
 *   generateProbeConfig: BoundGenerateProbeConfigFn
 * }} EnrichedBreakpoint
 */

/**
 * The live‑debugger integration test harness returned by {@link setup}. Provides the spawned app process, fake agent,
 * axios client, and helpers to generate remote config and trigger breakpoints.
 *
 * @typedef {object} DebuggerTestEnvironment
 * @property {BreakpointInfo} breakpoint - Primary breakpoint metadata.
 * @property {EnrichedBreakpoint[]} breakpoints - All discovered breakpoints with helpers.
 * @property {import('axios').AxiosInstance} axios - HTTP client bound to the test app. Throws if accessed before
 *   `beforeEach` hook runs.
 * @property {string} appFile - Absolute path to the test app entry file. Throws if accessed before `before` hook runs.
 * @property {import('../helpers').FakeAgent} agent - Started fake agent instance. Throws if accessed before
 *   `beforeEach` hook runs.
 * @property {import('../helpers').SpawnedProcess} proc - Spawned app process. Throws if accessed before `beforeEach`
 *   hook runs.
 * @property {object|null} rcConfig - Default remote config for the primary breakpoint.
 * @property {() => Promise<import('axios').AxiosResponse<unknown>>} triggerBreakpoint - Triggers the primary breakpoint
 *   once installed.
 * @property {(overrides?: object) => object} generateRemoteConfig - Generates RC for the primary breakpoint.
 * @property {BoundGenerateProbeConfigFn} generateProbeConfig - Generates probe config for the primary breakpoint.
 * @property {() => Promise<object>} snapshotReceived - Waits for a snapshot to be received from the test app.
 */

module.exports = {
  assertBasicInputPayload,
  pollInterval,
  setup,
  setupAssertionListeners,
  testBasicInput,
  testBasicInputWithoutDD,
  testBasicInputWithoutRC,
}

/**
 * Setup the integration test harness for live‑debugger scenarios.
 *
 * @param {object} [options] The options for the test environment.
 * @param {object} [options.env] The environment variables to set in the test environment.
 * @param {string} [options.testApp] The path to the test application file.
 * @param {string} [options.testAppSource] The path to the test application source file.
 * @param {string[]} [options.dependencies] The dependencies to install in the test environment.
 * @param {boolean} [options.silent] Whether to silence the output of the test environment.
 * @param {(data: Buffer) => void} [options.stdioHandler] The function to handle the standard output of the test
 *   environment.
 * @param {(data: Buffer) => void} [options.stderrHandler] The function to handle the standard error output of the test
 *   environment.
 * @returns {DebuggerTestEnvironment} Test harness with agent, app process, axios client and breakpoint helpers.
 */
function setup ({ env, testApp, testAppSource, dependencies, silent, stdioHandler, stderrHandler } = {}) {
  let cwd, axios, appFile, agent, proc

  const breakpoints = getBreakpointInfo({
    deployedFile: testApp,
    sourceFile: testAppSource,
    stackIndex: 1, // `1` to disregard the `setup` function
  }).map((breakpoint) => /** @type {EnrichedBreakpoint} */ ({
    rcConfig: null,
    triggerBreakpoint: triggerBreakpoint.bind(null, breakpoint.url),
    generateRemoteConfig: generateRemoteConfig.bind(null, breakpoint),
    generateProbeConfig: generateProbeConfig.bind(null, breakpoint),
    ...breakpoint,
  }))

  /** @type {DebuggerTestEnvironment} */
  const t = {
    breakpoint: breakpoints[0],
    breakpoints,

    get axios () {
      assert(axios, 'axios must be initialized in beforeEach hook')
      return axios
    },
    get appFile () {
      assert(appFile, 'appFile must be initialized in before hook')
      return appFile
    },
    get agent () {
      assert(agent, 'agent must be initialized in beforeEach hook')
      return agent
    },
    get proc () {
      assert(proc, 'proc must be initialized in beforeEach hook')
      return proc
    },

    // Default to the first breakpoint in the file (normally there's only one)
    rcConfig: null,
    triggerBreakpoint: triggerBreakpoint.bind(null, breakpoints[0].url),
    generateRemoteConfig: generateRemoteConfig.bind(null, breakpoints[0]),
    generateProbeConfig: generateProbeConfig.bind(null, breakpoints[0]),

    snapshotReceived () {
      return new Promise((/** @type {(value: object) => void} */ resolve) => {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot } }] }) => {
          resolve(snapshot)
        })
      })
    },
  }

  /**
   * Trigger the breakpoint once probe is successfully installed
   *
   * @param {string} url The URL of the HTTP route containing the breakpoint to trigger.
   * @returns {Promise<import('axios').AxiosResponse<unknown>>} A promise that resolves with the response from the HTTP
   *   request after the breakpoint is triggered.
   */
  async function triggerBreakpoint (url) {
    return new Promise((resolve, reject) => {
      t.agent.on('debugger-diagnostics', diagnosticsReceived)

      function diagnosticsReceived ({ payload }) {
        payload.some((event) => {
          if (event.debugger.diagnostics.status === 'INSTALLED') {
            t.agent.removeListener('debugger-diagnostics', diagnosticsReceived)
            t.axios.get(url).then(resolve).catch(reject)
            return true
          }
          return false
        })
      }
    })
  }

  /**
   * Generate a remote config for a breakpoint
   *
   * @param {BreakpointInfo} breakpoint - The breakpoint to generate a remote config for.
   * @param {object} [overrides] - The overrides to apply to the remote config.
   * @returns {object} - The remote config.
   */
  function generateRemoteConfig (breakpoint, overrides = {}) {
    overrides.id = overrides.id || randomUUID()
    return {
      product: 'LIVE_DEBUGGING',
      id: `logProbe_${overrides.id}`,
      config: generateProbeConfig(breakpoint, overrides),
    }
  }

  useSandbox(dependencies)

  before(function () {
    cwd = sandboxCwd()
    // The sandbox uses the `integration-tests` folder as its root
    appFile = join(cwd, 'debugger', breakpoints[0].deployedFile)
  })

  beforeEach(async function () {
    // Default to the first breakpoint in the file (normally there's only one)
    t.rcConfig = generateRemoteConfig(breakpoints[0])
    // Allow specific access to each breakpoint
    t.breakpoints.forEach((breakpoint) => { breakpoint.rcConfig = generateRemoteConfig(breakpoint) })

    agent = await new FakeAgent().start()
    proc = await spawnProc(/** @type {string} */ (t.appFile), {
      cwd,
      env: {
        DD_DYNAMIC_INSTRUMENTATION_ENABLED: 'true',
        DD_DYNAMIC_INSTRUMENTATION_UPLOAD_INTERVAL_SECONDS: '0',
        DD_TRACE_AGENT_PORT: t.agent.port,
        DD_TRACE_DEBUG: process.env.DD_TRACE_DEBUG, // inherit to make debugging the sandbox easier
        DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: pollInterval,
        ...env,
      },
      silent: silent ?? false,
    }, stdioHandler, stderrHandler)
    axios = Axios.create({ baseURL: t.proc.url })
  })

  afterEach(async function () {
    t.proc?.kill()
    await t.agent?.stop()
  })

  return t
}

/**
 * Get breakpoint information from a test file by scanning for BREAKPOINT_TOKEN markers.
 *
 * @param {object} [options] - Options for finding breakpoints.
 * @param {string} [options.deployedFile] - The deployed file path. If not provided, will be inferred from the stack
 *   trace.
 * @param {string} [options.sourceFile] - The source file path. Defaults to `deployedFile` if not provided.
 * @param {number} [options.stackIndex=0] - The stack index to use when inferring the file from the stack trace.
 * @returns {BreakpointInfo[]} An array of breakpoint information objects found in the file.
 */
function getBreakpointInfo ({ deployedFile, sourceFile = deployedFile, stackIndex = 0 } = {}) {
  if (!deployedFile) {
    // First, get the filename of file that called this function
    const testFile = /** @type {string} */ (new Error().stack)
      .split('\n')[stackIndex + 2] // +2 to skip this function + the first line, which is the error message
      .split(' (')[1]
      .slice(0, -1)
      .split(':')[0]

    // Then, find the corresponding file in which the breakpoint(s) exists
    deployedFile = sourceFile = join('target-app', basename(testFile).replace('.spec', ''))
  }

  assert(sourceFile, 'sourceFile must be provided or inferred from stack trace')

  // Finally, find the line number(s) of the breakpoint(s)
  const lines = readFileSync(join(__dirname, sourceFile), 'utf8').split('\n')
  const result = []
  for (let i = 0; i < lines.length; i++) {
    const index = lines[i].indexOf(BREAKPOINT_TOKEN)
    if (index !== -1) {
      const url = lines[i].slice(index + BREAKPOINT_TOKEN.length + 1).trim()
      result.push({ sourceFile, deployedFile, line: i + 1, url })
    }
  }

  return result
}

/**
 * Test helper for basic input messages with remote config and tracing.
 *
 * @param {DebuggerTestEnvironment} t - The test environment.
 * @param {Function} done - The mocha done callback.
 */
function testBasicInput (t, done) {
  t.triggerBreakpoint()
  setupAssertionListeners(t, done)
  t.agent.addRemoteConfig(t.rcConfig)
}

/**
 * Test helper for basic input messages without remote config (e.g., from probe file).
 *
 * @param {DebuggerTestEnvironment} t - The test environment.
 * @param {import('../../packages/dd-trace/test/debugger/devtools_client/utils').ProbeConfig} probe - The probe config.
 * @param {Function} done - The mocha done callback.
 */
function testBasicInputWithoutRC (t, probe, done) {
  t.triggerBreakpoint()
  setupAssertionListeners(t, done, probe)
}

/**
 * Setup assertion listeners for basic input tests with tracing integration.
 *
 * @param {DebuggerTestEnvironment} t - The test environment.
 * @param {Function} done - The mocha done callback.
 * @param {import('../../packages/dd-trace/test/debugger/devtools_client/utils').ProbeConfig} [probe] - Optional probe
 *   config to use instead of t.rcConfig.config.
 */
function setupAssertionListeners (t, done, probe) {
  let traceId, spanId, dd

  const messageListener = ({ payload }) => {
    const span = payload.find((arr) => arr[0].name === 'fastify.request')?.[0]
    if (!span) return

    traceId = span.trace_id.toString()
    spanId = span.span_id.toString()

    t.agent.removeListener('message', messageListener)

    assertDD()
  }

  t.agent.on('message', messageListener)

  t.agent.once('debugger-input', ({ payload }) => {
    assertBasicInputPayload(t, payload, probe)

    payload = payload[0]
    assert.ok(typeof payload.dd === 'object' && payload.dd !== null)
    assert.deepStrictEqual(['span_id', 'trace_id'], Object.keys(payload.dd).sort())
    assert.strictEqual(typeof payload.dd.trace_id, 'string')
    assert.strictEqual(typeof payload.dd.span_id, 'string')
    assert.ok(payload.dd.trace_id.length > 0)
    assert.ok(payload.dd.span_id.length > 0)
    dd = payload.dd

    assertDD()
  })

  function assertDD () {
    if (!traceId || !spanId || !dd) return
    assert.strictEqual(dd.trace_id, traceId)
    assert.strictEqual(dd.span_id, spanId)
    done()
  }
}

/**
 * Test helper for basic input messages without DD tracing integration.
 *
 * @param {DebuggerTestEnvironment} t - The test environment.
 * @param {Function} done - The mocha done callback.
 */
function testBasicInputWithoutDD (t, done) {
  t.triggerBreakpoint()

  t.agent.on('debugger-input', ({ payload }) => {
    assertBasicInputPayload(t, payload)
    assert.ok(!('dd' in payload[0]))
    done()
  })

  t.agent.addRemoteConfig(t.rcConfig)
}

/**
 * Assert that the basic input payload structure and content is correct.
 *
 * @param {DebuggerTestEnvironment} t - The test environment.
 * @param {Array<object>} payload - The debugger input payload.
 * @param {import('../../packages/dd-trace/test/debugger/devtools_client/utils').ProbeConfig} [probe] - Optional probe
 *   config to use instead of t.rcConfig.config.
 */
function assertBasicInputPayload (t, payload, probe = t.rcConfig.config) {
  assert.ok(Array.isArray(payload))
  assert.strictEqual(payload.length, 1)
  const data = payload[0]

  const expected = {
    ddsource: 'dd_debugger',
    hostname: os.hostname(),
    service: 'node',
    message: 'Hello World!',
    logger: {
      name: t.breakpoint.deployedFile,
      method: 'fooHandler',
      version,
      thread_name: 'MainThread',
    },
    debugger: {
      snapshot: {
        probe: {
          id: probe.id,
          version: 0,
          location: { file: t.breakpoint.deployedFile, lines: [String(t.breakpoint.line)] },
        },
        language: 'javascript',
      },
    },
  }

  assertObjectContains(data, expected)

  assert.match(data.logger.thread_id, /^pid:\d+$/)

  assertUUID(data.debugger.snapshot.id)
  assert.strictEqual(typeof data.debugger.snapshot.timestamp, 'number')
  assert.ok(data.debugger.snapshot.timestamp > Date.now() - 1000 * 60)
  assert.ok(data.debugger.snapshot.timestamp <= Date.now())

  assert.ok(Array.isArray(data.debugger.snapshot.stack))
  assert.ok(data.debugger.snapshot.stack.length > 0)
  for (const frame of data.debugger.snapshot.stack) {
    assert.ok(typeof frame === 'object' && frame !== null)
    assert.deepStrictEqual(['columnNumber', 'fileName', 'function', 'lineNumber'], Object.keys(frame).sort())
    assert.strictEqual(typeof frame.fileName, 'string')
    assert.strictEqual(typeof frame.function, 'string')
    assert.ok(frame.lineNumber > 0)
    assert.ok(frame.columnNumber > 0)
  }
  const topFrame = data.debugger.snapshot.stack[0]
  // path seems to be prefixed with `/private` on Mac
  assert.match(topFrame.fileName, new RegExp(`${t.appFile}$`))
  assert.strictEqual(topFrame.function, 'fooHandler')
  assert.strictEqual(topFrame.lineNumber, t.breakpoint.line)
  assert.strictEqual(topFrame.columnNumber, 3)
}
