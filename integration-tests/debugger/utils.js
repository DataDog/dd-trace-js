'use strict'

const { basename, join } = require('path')
const { readFileSync } = require('fs')
const { randomUUID } = require('crypto')

const getPort = require('get-port')
const Axios = require('axios')

const { createSandbox, FakeAgent, spawnProc } = require('../helpers')
const { generateProbeConfig } = require('../../packages/dd-trace/test/debugger/devtools_client/utils')

const BREAKPOINT_TOKEN = '// BREAKPOINT'
const pollInterval = 1

module.exports = {
  pollInterval,
  setup
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
        t.axios.get(breakpoint.url)
      }
    })
  }

  function generateRemoteConfig (overrides = {}) {
    overrides.id = overrides.id || randomUUID()
    return {
      product: 'LIVE_DEBUGGING',
      id: `logProbe_${overrides.id}`,
      config: generateProbeConfig(breakpoint, overrides)
    }
  }

  before(async function () {
    sandbox = await createSandbox(['fastify']) // TODO: Make this dynamic
    cwd = sandbox.folder
    // The sandbox uses the `integration-tests` folder as its root
    t.appFile = join(cwd, 'debugger', breakpoint.file)
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
  const file = join('target-app', basename(testFile).replace('.spec', ''))

  // Finally, find the line number of the breakpoint
  const lines = readFileSync(join(__dirname, file), 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const index = lines[i].indexOf(BREAKPOINT_TOKEN)
    if (index !== -1) {
      const url = lines[i].slice(index + BREAKPOINT_TOKEN.length + 1).trim()
      return { file, line: i + 1, url }
    }
  }
}
