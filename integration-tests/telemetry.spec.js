'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

const { afterEach, before, beforeEach, describe, it } = require('mocha')

const { bundlerMarker } = require('../packages/datadog-instrumentations/src/helpers/bundler-telemetry')
const {
  sandboxCwd,
  useSandbox,
  FakeAgent,
  spawnProc,
  spawnProcAndExpectExit,
  stopProc,
  assertObjectContains,
} = require('./helpers')

const execFileAsync = promisify(execFile)

describe('telemetry', () => {
  describe('bundler usage', () => {
    let agent
    let usage

    beforeEach(async () => {
      usage = []
      agent = await new FakeAgent().start()
      agent.on('telemetry', ({ payload }) => {
        if (payload.request_type !== 'generate-metrics' || payload.payload.namespace !== 'tracers') return
        usage.push(...payload.payload.series.filter(({ metric }) => metric === 'bundler.used'))
      })
    })

    afterEach(async () => {
      await agent.stop()
    })

    /** @param {Record<string, string>} [env] */
    async function runMarkedBundle (env) {
      const preloader = require.resolve('../init.js')
      const telemetry = require.resolve('../packages/dd-trace/src/telemetry')
      await execFileAsync(process.execPath, ['-r', preloader, '-e', `
        const { flush } = require(${JSON.stringify(telemetry)});
        ${bundlerMarker('esbuild')}
        ${bundlerMarker('esbuild')}
        flush();
        ${bundlerMarker('vite')}
      `], {
        env: {
          ...process.env,
          DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
          DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
          DD_TELEMETRY_METRICS_ENABLED: 'true',
          ...env,
        },
      })
    }

    it('reports each bundler only once, including ones loaded after the tracer starts', async () => {
      await runMarkedBundle()
      const counts = usage.map(({ tags, points, type }) => [tags, points.map(point => point[1]), type])
      assert.deepStrictEqual(counts.sort(), [
        [['bundler:esbuild'], [1], 'count'],
        [['bundler:vite'], [1], 'count'],
      ])
    })

    for (const setting of ['DD_INSTRUMENTATION_TELEMETRY_ENABLED', 'DD_TELEMETRY_METRICS_ENABLED']) {
      it(`does not report when ${setting} is disabled`, async () => {
        await runMarkedBundle({ [setting]: 'false' })
        assert.deepStrictEqual(usage, [])
      })
    }
  })

  describe('ESM dependencies', () => {
    // Both entry points register the synchronous loader (module.registerHooks) on Node.js versions that
    // support it, and the asynchronous loader (module.register) otherwise.
    const setups = [
      { execArgv: ['--import', 'dd-trace/initialize.mjs'], app: 'index.mjs' },
      { execArgv: ['--import', 'dd-trace/register.js', '--require', 'dd-trace/init'], app: 'index.mjs' },
      { execArgv: ['--import', 'dd-trace/register.js'], app: 'late-init.mjs' },
      { execArgv: ['--import', 'dd-trace/initialize.mjs'], app: 'short-lived.mjs', exits: true },
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

    for (const { execArgv, app, exits } of setups) {
      it(`reports non-instrumented packages loaded as ESM with ${execArgv.join(' ')} (${app})`, async () => {
        proc = undefined
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

        const appFile = path.join(cwd, 'telemetry/esm-dependencies', app)
        const options = { cwd, execArgv, env: { DD_TRACE_AGENT_PORT: String(agent.port) } }
        const spawned = exits
          ? spawnProcAndExpectExit(appFile, options)
          : spawnProc(appFile, options).then(spawnedProc => { proc = spawnedProc })

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
