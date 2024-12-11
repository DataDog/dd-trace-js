'use strict'

const { basename, join } = require('path')
const { readFileSync } = require('fs')
const { randomUUID } = require('crypto')

const getPort = require('get-port')
const Axios = require('axios')

const { createSandbox, FakeAgent, spawnProc } = require('../helpers')

const pollInterval = 1

module.exports = {
  pollInterval,
  setup,
  getBreakpointInfo
}

function setup () {
  let sandbox, cwd, appPort
  const breakpoint = getBreakpointInfo(1) // `1` to disregard the `setup` function
  const t = {
    breakpoint,
    axios: null,
    appFile: null,
    agent: null,
    rcConfig: null,
    triggerBreakpoint,
    generateRemoteConfig,
    generateProbeConfig
  }

  function triggerBreakpoint () {
    // Trigger the breakpoint once probe is successfully installed
    t.agent.on('debugger-diagnostics', ({ payload }) => {
      if (payload.debugger.diagnostics.status === 'INSTALLED') {
        t.axios.get('/foo')
      }
    })
  }

  function generateRemoteConfig (overrides = {}) {
    overrides.id = overrides.id || randomUUID()
    return {
      product: 'LIVE_DEBUGGING',
      id: `logProbe_${overrides.id}`,
      config: generateProbeConfig(overrides)
    }
  }

  function generateProbeConfig (overrides = {}) {
    overrides.capture = { maxReferenceDepth: 3, ...overrides.capture }
    overrides.sampling = { snapshotsPerSecond: 5000, ...overrides.sampling }
    return {
      id: randomUUID(),
      version: 0,
      type: 'LOG_PROBE',
      language: 'javascript',
      where: { sourceFile: breakpoint.file, lines: [String(breakpoint.line)] },
      tags: [],
      template: 'Hello World!',
      segments: [{ str: 'Hello World!' }],
      captureSnapshot: false,
      evaluateAt: 'EXIT',
      ...overrides
    }
  }

  before(async function () {
    sandbox = await createSandbox(['fastify']) // TODO: Make this dynamic
    cwd = sandbox.folder
    t.appFile = join(cwd, ...breakpoint.file.split('/'))
  })

  after(async function () {
    await sandbox.remove()
  })

  beforeEach(async function () {
    t.rcConfig = generateRemoteConfig(breakpoint)
    appPort = await getPort()
    t.agent = await new FakeAgent().start()
    t.proc = await spawnProc(t.appFile, {
      cwd,
      env: {
        APP_PORT: appPort,
        DD_DYNAMIC_INSTRUMENTATION_ENABLED: true,
        DD_TRACE_AGENT_PORT: t.agent.port,
        DD_TRACE_DEBUG: process.env.DD_TRACE_DEBUG, // inherit to make debugging the sandbox easier
        DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: pollInterval
      }
    })
    t.axios = Axios.create({
      baseURL: `http://localhost:${appPort}`
    })
  })

  afterEach(async function () {
    t.proc.kill()
    await t.agent.stop()
  })

  return t
}

function getBreakpointInfo (stackIndex = 0) {
  // First, get the filename of file that called this function
  const testFile = new Error().stack
    .split('\n')[stackIndex + 2] // +2 to skip this function + the first line, which is the error message
    .split(' (')[1]
    .slice(0, -1)
    .split(':')[0]

  // Then, find the corresponding file in which the breakpoint exists
  const filename = basename(testFile).replace('.spec', '')

  // Finally, find the line number of the breakpoint
  const line = readFileSync(join(__dirname, 'target-app', filename), 'utf8')
    .split('\n')
    .findIndex(line => line.includes('// BREAKPOINT')) + 1

  return { file: `debugger/target-app/${filename}`, line }
}
