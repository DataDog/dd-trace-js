'use strict'

const assert = require('assert')
const { basename, join } = require('path')
const { readFileSync } = require('fs')
const { randomUUID } = require('crypto')

const Axios = require('axios')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../helpers')
const { generateProbeConfig } = require('../../packages/dd-trace/test/debugger/devtools_client/utils')

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
 * @typedef {Object} BreakpointInfo
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
 *   triggerBreakpoint: (url: string) => Promise<import('axios').AxiosResponse<unknown>>,
 *   generateRemoteConfig: (overrides?: object) => object,
 *   generateProbeConfig: GenerateProbeConfigFn
 * }} EnrichedBreakpoint
 */

/**
 * The live‑debugger integration test harness returned by {@link setup}. Provides the spawned app process, fake agent,
 * axios client, and helpers to generate remote config and trigger breakpoints.
 *
 * @typedef {Object} DebuggerTestEnvironment
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
 * @property {GenerateProbeConfigFn} generateProbeConfig - Generates probe config for the primary breakpoint.
 */

module.exports = {
  pollInterval,
  setup
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
    stackIndex: 1 // `1` to disregard the `setup` function
  }).map((breakpoint) => /** @type {EnrichedBreakpoint} */ ({
    rcConfig: null,
    triggerBreakpoint: triggerBreakpoint.bind(null, breakpoint.url),
    generateRemoteConfig: generateRemoteConfig.bind(null, breakpoint),
    generateProbeConfig: generateProbeConfig.bind(null, breakpoint),
    ...breakpoint
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
    generateProbeConfig: generateProbeConfig.bind(null, breakpoints[0])
  }

  /**
   * Trigger the breakpoint once probe is successfully installed
   *
   * @param {string} url The URL of the HTTP route containing the breakpoint to trigger.
   * @returns {Promise<import('axios').AxiosResponse<unknown>>} A promise that resolves with the response from the HTTP
   *   request after the breakpoint is triggered.
   */
  async function triggerBreakpoint (url) {
    let triggered = false
    return new Promise((resolve, reject) => {
      t.agent.on('debugger-diagnostics', ({ payload }) => {
        payload.forEach((event) => {
          if (!triggered && event.debugger.diagnostics.status === 'INSTALLED') {
            triggered = true
            t.axios.get(url).then(resolve).catch(reject)
          }
        })
      })
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
      config: generateProbeConfig(breakpoint, overrides)
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
        ...env
      },
      silent: silent ?? false
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
 * @param {Object} [options] - Options for finding breakpoints.
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
