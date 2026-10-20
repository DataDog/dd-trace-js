'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { afterEach, before, beforeEach, describe, it } = require('mocha')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc, stopProc, assertObjectContains } = require('./helpers')

describe('telemetry', () => {
  describe('ESM dependencies', () => {
    // initialize.mjs always registers the asynchronous loader (module.register). register.js
    // registers the synchronous loader (module.registerHooks) on Node.js versions that support it.
    const setups = [
      { execArgv: ['--import', 'dd-trace/initialize.mjs'], app: 'index.mjs' },
      { execArgv: ['--import', 'dd-trace/register.js', '--require', 'dd-trace/init'], app: 'index.mjs' },
      { execArgv: ['--import', 'dd-trace/register.js'], app: 'late-init.mjs' },
    ]

    let cwd
    let agent
    let proc

    useSandbox(['axios', 'nanoid'])

    before(() => {
      cwd = sandboxCwd()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const { execArgv, app } of setups) {
      it(`reports non-instrumented ESM-only packages with ${execArgv.join(' ')} (${app})`, async () => {
        agent = await new FakeAgent().start()

        const reported = new Set()

        // Listen before spawning: the dependencies loaded at startup are sent before the app reports its port.
        const telemetryReceived = agent.assertTelemetryReceived({
          fn: ({ payload }) => {
            for (const { name } of payload.payload.dependencies ?? []) {
              reported.add(name)
            }
            assert.ok(reported.has('axios'), `axios not reported, got: ${[...reported].join(', ')}`)
            assert.ok(reported.has('nanoid'), `nanoid not reported, got: ${[...reported].join(', ')}`)
          },
          requestType: 'app-dependencies-loaded',
          resolveAtFirstSuccess: true,
          timeout: 10_000,
        })

        const spawned = spawnProc(path.join(cwd, 'telemetry/esm-dependencies', app), {
          cwd,
          execArgv,
          env: {
            DD_TRACE_AGENT_PORT: String(agent.port),
          },
        }).then(spawnedProc => { proc = spawnedProc })

        await Promise.all([spawned, telemetryReceived])
      })
    }
  })

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
