'use strict'

const dc = require('node:diagnostics_channel')
const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')

const agent = require('./agent')

const instrumentationsSymbol = Symbol.for('_ddtrace_instrumentations')

describe('test agent helper', () => {
  describe('agent.load contract', () => {
    afterEach(() => agent.close())

    it('resolves with the live TracerProxy', async () => {
      const tracer = await agent.load([])
      assert.strictEqual(tracer, global._ddtrace)
    })

    it('reuses the cached tracer for repeat loads without close', async () => {
      const first = await agent.load([])
      const second = await agent.load([])
      assert.strictEqual(second, first)
    })

    it('rebuilds the tracer on close+load even with identical args', async () => {
      await agent.load([])
      const firstId = global._ddtrace._tracer._config.tags['runtime-id']
      await agent.close()

      await agent.load([])
      const secondId = global._ddtrace._tracer._config.tags['runtime-id']
      assert.notStrictEqual(secondId, firstId)
    })

    it('rebuilds the tracer when tracerConfig differs between consecutive loads', async () => {
      await agent.load([], {}, { service: 'first', codeOriginForSpans: { enabled: false } })
      const firstConfig = global._ddtrace._tracer._config
      assert.strictEqual(firstConfig.codeOriginForSpans.enabled, false)

      await agent.load([], {}, { service: 'second', codeOriginForSpans: { enabled: true } })
      const secondConfig = global._ddtrace._tracer._config
      assert.notStrictEqual(secondConfig, firstConfig)
      assert.strictEqual(secondConfig.codeOriginForSpans.enabled, true)
      assert.strictEqual(secondConfig.service, 'second')
    })

    it('rebuilds when a previously-passed tracerConfig is mutated in place', async () => {
      const cfg = { service: 'first' }
      await agent.load([], {}, cfg)
      const firstId = global._ddtrace._tracer._config.tags['runtime-id']

      cfg.service = 'second'
      await agent.load([], {}, cfg)
      assert.notStrictEqual(global._ddtrace._tracer._config.tags['runtime-id'], firstId)
      assert.strictEqual(global._ddtrace._tracer._config.service, 'second')
    })

    it('rebuilds the tracer when a DD_* env changes between consecutive loads', async () => {
      await agent.load([])
      const firstId = global._ddtrace._tracer._config.tags['runtime-id']

      process.env.DD_RUNTIME_METRICS_FLUSH_INTERVAL = '5000'
      try {
        await agent.load([])
        assert.notStrictEqual(global._ddtrace._tracer._config.tags['runtime-id'], firstId)
      } finally {
        delete process.env.DD_RUNTIME_METRICS_FLUSH_INTERVAL
      }
    })

    it('rebuilds the tracer when an OTEL_* env changes between consecutive loads', async () => {
      await agent.load([])
      const firstId = global._ddtrace._tracer._config.tags['runtime-id']

      process.env.OTEL_LOG_LEVEL = 'debug'
      try {
        await agent.load([])
        assert.notStrictEqual(global._ddtrace._tracer._config.tags['runtime-id'], firstId)
      } finally {
        delete process.env.OTEL_LOG_LEVEL
      }
    })

    it('re-registers previously loaded plugins after an auto-wipe', async () => {
      await agent.load(['http'], {})
      const first = global._ddtrace

      await agent.load(['express'], {}, { service: 'fresh' })
      assert.notStrictEqual(global._ddtrace, first)

      const configured = global._ddtrace._pluginManager._configsByName
      assert.ok(configured.http, `http missing, configured = ${Object.keys(configured)}`)
      assert.ok(configured.express, `express missing, configured = ${Object.keys(configured)}`)
    })

    it('drops accumulated plugins on agent.close', async () => {
      await agent.load(['http', 'express'])
      await agent.close()

      await agent.load(['express'], {}, { service: 'fresh' })
      const configured = global._ddtrace._pluginManager._configsByName
      assert.ok(configured.express, `express missing, configured = ${Object.keys(configured)}`)
      assert.notStrictEqual(configured.http?.enabled, true)
    })

    // Single-eval invariant: each `datadog-instrumentations/*.js` file evaluates
    // exactly once per process. `addHook` pushes one entry into
    // `instrumentations[name]` per evaluation, so the array length is the eval
    // count. Master's `proxyquire` cascade re-evaluated these files transitively
    // and stacked shimmer wraps on already-patched library functions.
    it('does not re-register an integration on subsequent loads', async () => {
      await agent.load(['child_process'])
      // Force the host library to load so the entry appears in the
      // `instrumentations` table — otherwise the assertion races against the
      // first `require('child_process')` that happens to fire later.
      require('child_process')
      const instrumentations = globalThis[instrumentationsSymbol]
      const initialEntries = instrumentations.child_process.length
      await agent.close()

      await agent.load(['child_process'], {}, { sampleRate: 0.1 })
      assert.strictEqual(instrumentations.child_process.length, initialEntries)

      await agent.close()
      await agent.load(['child_process'], {}, { sampleRate: 0.2 })
      assert.strictEqual(instrumentations.child_process.length, initialEntries)
    })

    // Patched library code closure-captures `tracingChannel(...)` at module-load,
    // and `Subscription._channel` resolves `dc.channel(name)` at subscribe time;
    // both paths must end at the same Channel singleton or the patch publishes
    // to a channel nobody listens on (V8's WeakRef-backed dc registry).
    it('keeps each diagnostic-channel singleton stable across reloads', async () => {
      await agent.load(['child_process'])
      require('child_process')
      const firstChannel = dc.channel('tracing:datadog:child_process:execution:start')
      await agent.close()

      await agent.load(['child_process'], {}, { sampleRate: 0.1 })
      const secondChannel = dc.channel('tracing:datadog:child_process:execution:start')
      assert.strictEqual(secondChannel, firstChannel)
    })
  })

  describe('agent.load — non-DD/OTEL env mutation does not retrigger the gate', () => {
    afterEach(() => agent.close())

    it('takes the cheap path on a non-tracked env mutation', async () => {
      await agent.load([])
      const first = global._ddtrace

      process.env.SOME_TEST_NOISE = 'foo'
      try {
        await agent.load([])
        assert.strictEqual(global._ddtrace, first)
      } finally {
        delete process.env.SOME_TEST_NOISE
      }
    })
  })

  describe('assertSomeTraces timeout', () => {
    afterEach(() => agent.close())

    it('rejects at the timeout when no payload arrives', async () => {
      await agent.load([])

      const start = Date.now()
      await assert.rejects(
        agent.assertSomeTraces(() => {}, { timeoutMs: 200 }),
        { message: /No matching trace received within 200ms/ }
      )
      assert.ok(Date.now() - start < 1000, 'rejected well before Mocha\'s 5s timeout')
    })
  })

  describe('assertNoTraces', () => {
    afterEach(() => agent.close())

    it('resolves at the timeout when no forbidden trace arrives', async () => {
      const tracer = await agent.load('dns')

      const start = Date.now()
      await agent.assertNoTraces(() => {
        assert.fail('no trace should have been produced')
      }, { timeoutMs: 200 })
      const elapsed = Date.now() - start
      assert.ok(elapsed >= 200, `resolved before the timeout window (${elapsed}ms)`)
      assert.ok(elapsed < 1000, `resolved well after the timeout window (${elapsed}ms)`)

      assert.strictEqual(tracer, global._ddtrace)
    })

    it('rejects when a forbidden trace arrives', async () => {
      const tracer = await agent.load('dns')
      const dns = require('node:dns')

      const rejection = assert.rejects(
        agent.assertNoTraces(traces => {
          if (traces[0][0].name === 'dns.lookup') {
            assert.fail('dns.lookup should not have been traced')
          }
        }, { timeoutMs: 5000 }),
        { message: /dns\.lookup should not have been traced/ }
      )

      dns.lookup('localhost', () => {})
      await rejection

      assert.strictEqual(tracer, global._ddtrace)
    })
  })
})
