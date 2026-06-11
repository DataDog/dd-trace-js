'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { afterEach, before, beforeEach, describe, it } = require('mocha')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc, stopProc, assertObjectContains } = require('./helpers')

describe('telemetry', () => {
  describe('dependencies', () => {
    let cwd
    let startupTestFile
    let agent
    let proc

    useSandbox()

    before(() => {
      cwd = sandboxCwd()
      startupTestFile = path.join(cwd, 'startup/index.js')
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(startupTestFile, {
        cwd,
        env: {
          AGENT_PORT: String(agent.port),
          DD_LOGS_INJECTION: 'true',
        },
      })
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    it('Test that tracer and iitm are sent as dependencies', async () => {
      let ddTraceFound = false
      let importInTheMiddleFound = false

      await agent.assertTelemetryReceived({
        fn: msg => {
          const { payload } = msg

          if (payload.request_type === 'app-dependencies-loaded') {
            if (payload.payload.dependencies) {
              payload.payload.dependencies.forEach(dependency => {
                if (dependency.name === 'dd-trace') {
                  ddTraceFound = true
                }
                if (dependency.name === 'import-in-the-middle') {
                  importInTheMiddleFound = true
                }
              })
            }
          }
        },
        requestType: 'app-dependencies-loaded',
        timeout: 5_000,
      })

      assert.strictEqual(ddTraceFound, true)
      assert.strictEqual(importInTheMiddleFound, true)
    })

    it('Assert configuration chaining data is sent', async () => {
      await agent.assertTelemetryReceived({
        fn: msg => {
          const { configuration } = msg.payload.payload
          assertObjectContains(configuration, [
            { name: 'DD_LOGS_INJECTION', value: true, origin: 'default' },
            { name: 'DD_LOGS_INJECTION', value: true, origin: 'env_var' },
            { name: 'DD_LOGS_INJECTION', value: false, origin: 'code' },
          ])
        },
        requestType: 'app-started',
        timeout: 5_000,
      })
    })
  })
})
