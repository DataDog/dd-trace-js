'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const path = require('node:path')

const {
  FakeAgent,
  sandboxCwd,
  stopProc,
  useSandbox,
} = require('../helpers')

const TIMEOUT = 30000
const ACKNOWLEDGED = 2

// Only asserts that a profile intake request arrived; the payload shape itself is covered by profiler.spec.js.
function expectProfileMessagePromise (agent, timeout) {
  return agent.assertMessageReceived(({ files }) => {
    assert.ok(files?.[0], 'Expected a multipart profile upload')
    assert.strictEqual(files[0].originalname, 'event.json')
  }, timeout, 1, true)
}

function expectTimeout (messagePromise) {
  return messagePromise.then(
    () => {
      throw new Error('Received unexpected profile upload')
    },
    (e) => {
      if (e.message !== 'timeout') throw e
    }
  )
}

function addRemoteConfigAndWaitForAck (agent, sdkConfig) {
  return /** @type {Promise<void>} */ (new Promise((resolve) => {
    const configId = Math.random().toString(36).slice(2)
    const handler = (id, version, state) => {
      if (id === configId && state === ACKNOWLEDGED) {
        agent.removeListener('remote-config-ack-update', handler)
        resolve()
      }
    }
    agent.on('remote-config-ack-update', handler)
    agent.addRemoteConfig({
      product: 'APM_TRACING',
      id: configId,
      config: {
        service_target: { service: 'node', env: '*' },
        sdk_config: sdkConfig,
      },
    })
  }))
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('Profiling Remote Config', function () {
  this.timeout(TIMEOUT)

  let cwd, agent, proc, profilerTestFile

  useSandbox()

  before(() => {
    cwd = sandboxCwd()
    profilerTestFile = path.join(cwd, 'profiler/index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  it('does not profile at boot, then starts profiling once remote config enables it', async () => {
    proc = fork(profilerTestFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_REMOTE_CONFIGURATION_ENABLED: 'true',
        DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: '0.1',
        DD_PROFILING_UPLOAD_PERIOD: '1',
        TEST_DURATION_MS: '8000',
      },
    })

    // Give remote config a few poll cycles to run with no config pushed yet: no profile should
    // ever be uploaded while profiling is off.
    await expectTimeout(expectProfileMessagePromise(agent, 1500))

    await addRemoteConfigAndWaitForAck(agent, { DD_PROFILING_ENABLED: 'true' })

    // The profiler was started well after boot; it should still capture and upload a profile
    // from the still-running app before it exits.
    await expectProfileMessagePromise(agent, TIMEOUT - 5000)
  })

  it('does not start the profiler again once remote config has already started it', async () => {
    proc = fork(profilerTestFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_REMOTE_CONFIGURATION_ENABLED: 'true',
        DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: '0.1',
        DD_PROFILING_UPLOAD_PERIOD: '1',
        TEST_DURATION_MS: '8000',
      },
    })

    await addRemoteConfigAndWaitForAck(agent, { DD_PROFILING_ENABLED: 'true' })
    await expectProfileMessagePromise(agent, TIMEOUT - 10000)

    // A second, unrelated remote config update re-triggers the batch handler; the profiler
    // should not be restarted (which would otherwise throw or duplicate exporters).
    await addRemoteConfigAndWaitForAck(agent, { DD_PROFILING_ENABLED: 'true' })
    await sleep(500)

    assert.strictEqual(proc.exitCode, null, 'Process should still be running, not crashed')
  })
})
