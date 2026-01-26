'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const Axios = require('axios')
const { FakeAgent, sandboxCwd, useSandbox, spawnProc } = require('./helpers')

const ACKNOWLEDGED = 2

describe('Code Origin Remote Config', function () {
  this.timeout(20000)

  let cwd, agent, proc, axios

  useSandbox(
    ['express', 'fastify'],
    false,
    [path.join(__dirname, 'code-origin')]
  )

  before(() => {
    cwd = sandboxCwd()
  })

  afterEach(async () => {
    proc?.kill()
    await agent?.stop()
  })

  const frameworks = [
    { name: 'Express', spanName: 'express.request', appFile: 'express-app.js' },
    { name: 'Fastify', spanName: 'fastify.request', appFile: 'fastify-app.js' }
  ]

  const setupApp = (framework, envVars) => async () => {
    const appFile = path.join(cwd, 'code-origin', framework.appFile)
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: 0.1,
        ...envVars
      }
    })
    axios = Axios.create({
      baseURL: proc.url,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const addRemoteConfigAndWaitForAck = (libConfig) => {
    return /** @type {Promise<void>} */ (new Promise((resolve) => {
      // Random config id - Just needs to be unique between calls to this function
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
          lib_config: libConfig
        }
      })
    }))
  }

  const assertCodeOriginPresent = (framework, url = '/hello') => {
    return Promise.all([
      agent.assertMessageReceived(({ payload }) => {
        const spans = payload.flatMap(p => p)
        const requestSpan = spans.find(span => span.name === framework.spanName)
        assert.ok(requestSpan, `${framework.spanName} span should exist`)
        assert.strictEqual(requestSpan.meta['_dd.code_origin.type'], 'entry')
        assert.ok(requestSpan.meta['_dd.code_origin.frames.0.file'])
        assert.ok(requestSpan.meta['_dd.code_origin.frames.0.line'])
      }, 3000),
      axios.get(url)
    ])
  }

  const assertCodeOriginAbsent = (framework, url = '/hello') => {
    return Promise.all([
      agent.assertMessageReceived(({ payload }) => {
        const spans = payload.flatMap(p => p)
        const requestSpan = spans.find(span => span.name === framework.spanName)
        assert.ok(requestSpan, `${framework.spanName} span should exist`)
        assert.strictEqual(requestSpan.meta['_dd.code_origin.type'], undefined)
        assert.strictEqual(requestSpan.meta['_dd.code_origin.frames.0.file'], undefined)
      }, 3000),
      axios.get(url)
    ])
  }

  frameworks.forEach(framework => {
    describe(framework.name, () => {
      describe('both CO and RC enabled at boot (runtime disable)', () => {
        beforeEach(setupApp(framework, {
          DD_CODE_ORIGIN_FOR_SPANS_ENABLED: 'true',
          DD_REMOTE_CONFIG_ENABLED: 'true'
        }))

        it('should disable code origin tags at runtime via remote config', async () => {
          // Step 1: Make a request with code origin enabled (default)
          await assertCodeOriginPresent(framework)

          // Verify config shows enabled
          const configBefore = await axios.get('/config')
          assert.strictEqual(configBefore.data.codeOriginEnabled, true)
          assert.strictEqual(configBefore.data.remoteConfigEnabled, true)

          // Step 2: Disable code origin via remote config
          await addRemoteConfigAndWaitForAck({ code_origin_enabled: false })

          // Verify config shows disabled
          const configAfter = await axios.get('/config')
          assert.strictEqual(configAfter.data.codeOriginEnabled, false)
          assert.strictEqual(configAfter.data.remoteConfigEnabled, true)

          // Step 3: Make another request and verify NO code origin tags
          // The tags are pre-computed and cached, but not applied since _enabled is false
          await assertCodeOriginAbsent(framework)
        })
      })

      describe('CO enabled at boot, RC disabled', () => {
        beforeEach(setupApp(framework, {
          DD_CODE_ORIGIN_FOR_SPANS_ENABLED: 'true',
          DD_REMOTE_CONFIG_ENABLED: 'false'
        }))

        it('should pre-compute and add code origin tags', async () => {
          // With CO enabled, tags should be computed and added normally
          await assertCodeOriginPresent(framework)
        })
      })

      describe('RC enabled at boot, CO disabled', () => {
        beforeEach(setupApp(framework, {
          DD_CODE_ORIGIN_FOR_SPANS_ENABLED: 'false',
          DD_REMOTE_CONFIG_ENABLED: 'true'
        }))

        it('should pre-compute but not add code origin tags, then add them after runtime enable', async () => {
          // Step 1: With RC enabled but CO disabled, tags are pre-computed (for potential runtime enabling)
          // but should NOT be applied to spans since CO is disabled
          await assertCodeOriginAbsent(framework)

          // Verify config shows CO disabled
          const configBefore = await axios.get('/config')
          assert.strictEqual(configBefore.data.codeOriginEnabled, false)
          assert.strictEqual(configBefore.data.remoteConfigEnabled, true)

          // Step 2: Enable code origin at runtime via remote config
          await addRemoteConfigAndWaitForAck({ code_origin_enabled: true })

          // Verify config shows CO enabled
          const configAfter = await axios.get('/config')
          assert.strictEqual(configAfter.data.codeOriginEnabled, true)

          // Step 3: Make another request and verify code origin tags ARE now present
          // This works because tags were pre-computed at boot when RC was enabled
          await assertCodeOriginPresent(framework)
        })
      })
    })
  })
})
