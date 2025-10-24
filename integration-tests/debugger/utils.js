'use strict'

const { basename, join } = require('path')
const { readFileSync } = require('fs')
const { randomUUID } = require('crypto')

const Axios = require('axios')

const { isolatedSandbox, FakeAgent, spawnProc } = require('../helpers')
const { generateProbeConfig } = require('../../packages/dd-trace/test/debugger/devtools_client/utils')

const BREAKPOINT_TOKEN = '// BREAKPOINT'
const pollInterval = 0.1

module.exports = {
  pollInterval,
  setup
}

function setup ({ env, testApp, testAppSource, dependencies, silent, stdioHandler, stderrHandler } = {}) {
  let sandbox, cwd

  const breakpoints = getBreakpointInfo({
    deployedFile: testApp,
    sourceFile: testAppSource,
    stackIndex: 1 // `1` to disregard the `setup` function
  })

  const t = {
    breakpoint: breakpoints[0],
    breakpoints,

    axios: null,
    appFile: null,
    agent: null,

    // Default to the first breakpoint in the file (normally there's only one)
    rcConfig: null,
    triggerBreakpoint: triggerBreakpoint.bind(null, breakpoints[0].url),
    generateRemoteConfig: generateRemoteConfig.bind(null, breakpoints[0]),
    generateProbeConfig: generateProbeConfig.bind(null, breakpoints[0])
  }

  // Allow specific access to each breakpoint
  for (let i = 0; i < breakpoints.length; i++) {
    t.breakpoints[i] = {
      rcConfig: null,
      triggerBreakpoint: triggerBreakpoint.bind(null, breakpoints[i].url),
      generateRemoteConfig: generateRemoteConfig.bind(null, breakpoints[i]),
      generateProbeConfig: generateProbeConfig.bind(null, breakpoints[i]),
      ...breakpoints[i]
    }
  }

  // Trigger the breakpoint once probe is successfully installed
  function triggerBreakpoint (url) {
    let triggered = false
    t.agent.on('debugger-diagnostics', ({ payload }) => {
      payload.forEach((event) => {
        if (!triggered && event.debugger.diagnostics.status === 'INSTALLED') {
          triggered = true
          t.axios.get(url)
        }
      })
    })
  }

  function generateRemoteConfig (breakpoint, overrides = {}) {
    overrides.id = overrides.id || randomUUID()
    return {
      product: 'LIVE_DEBUGGING',
      id: `logProbe_${overrides.id}`,
      config: generateProbeConfig(breakpoint, overrides)
    }
  }

  before(async function () {
    sandbox = await isolatedSandbox(dependencies)
    cwd = sandbox.folder
    // The sandbox uses the `integration-tests` folder as its root
    t.appFile = join(cwd, 'debugger', breakpoints[0].deployedFile)
  })

  after(async function () {
    await sandbox?.remove()
  })

  beforeEach(async function () {
    // Default to the first breakpoint in the file (normally there's only one)
    t.rcConfig = generateRemoteConfig(breakpoints[0])
    // Allow specific access to each breakpoint
    t.breakpoints.forEach((breakpoint) => { breakpoint.rcConfig = generateRemoteConfig(breakpoint) })

    t.agent = await new FakeAgent().start()
    t.proc = await spawnProc(t.appFile, {
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
    t.axios = Axios.create({ baseURL: t.proc.url })
  })

  afterEach(async function () {
    t.proc?.kill()
    await t.agent?.stop()
  })

  return t
}

function getBreakpointInfo ({ deployedFile, sourceFile = deployedFile, stackIndex = 0 } = {}) {
  if (!deployedFile) {
    // First, get the filename of file that called this function
    const testFile = new Error().stack
      .split('\n')[stackIndex + 2] // +2 to skip this function + the first line, which is the error message
      .split(' (')[1]
      .slice(0, -1)
      .split(':')[0]

    // Then, find the corresponding file in which the breakpoint(s) exists
    deployedFile = sourceFile = join('target-app', basename(testFile).replace('.spec', ''))
  }

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
