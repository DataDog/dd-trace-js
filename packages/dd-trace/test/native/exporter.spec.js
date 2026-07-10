'use strict'

const assert = require('node:assert/strict')
const { channel } = require('dc-polyfill')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('NativeExporter', () => {
  let NativeExporter
  let exporter
  let config
  let prioritySampler
  let nativeSpans
  let logError
  let logWarn
  let metricsIncrement
  let fetchAgentInfo
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers()

    config = {
      url: 'http://localhost:8126',
      flushInterval: 1000,
    }

    prioritySampler = {
      sample: sinon.stub(),
      update: sinon.stub(),
    }

    nativeSpans = {
      flushChangeQueue: sinon.stub(),
      flushSpansGrouped: sinon.stub().resolves('unchanged'),
      flushStats: sinon.stub().resolves(true),
      setAgentUrl: sinon.stub(),
      setUseV05: sinon.stub(),
      setOtlpEndpoint: sinon.stub(),
      setOtlpProtocol: sinon.stub(),
      setOtlpHeaders: sinon.stub(),
    }

    logError = sinon.stub()
    logWarn = sinon.stub()
    metricsIncrement = sinon.stub()
    fetchAgentInfo = sinon.stub()
    NativeExporter = proxyquire('../../src/exporters/native', {
      '../../log': {
        warn: logWarn,
        error: logError,
        debug: sinon.stub(),
      },
      '../../runtime_metrics': { increment: metricsIncrement },
      '../../agent/info': { fetchAgentInfo },
    })
  })

  afterEach(() => {
    clock.restore()
  })

  describe('v0.5 negotiation', () => {
    it('enables v0.5 when protocol is 0.5 and the agent advertises /v0.5/traces', () => {
      config.protocolVersion = '0.5'
      fetchAgentInfo.callsArgWith(1, null, { endpoints: ['/v0.4/traces', '/v0.5/traces'] })
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      sinon.assert.calledOnceWithExactly(nativeSpans.setUseV05, true)
    })

    it('stays on v0.4 when protocol is 0.5 but the agent lacks /v0.5/traces', () => {
      config.protocolVersion = '0.5'
      fetchAgentInfo.callsArgWith(1, null, { endpoints: ['/v0.4/traces'] })
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      sinon.assert.notCalled(nativeSpans.setUseV05)
    })

    it('stays on v0.4 when /info omits or malforms endpoints', () => {
      config.protocolVersion = '0.5'
      // No `endpoints` key, and a non-array value — neither may enable v0.5
      // or throw in the async callback.
      fetchAgentInfo.callsArgWith(1, null, {})
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      fetchAgentInfo.callsArgWith(1, null, { endpoints: '/v0.5/traces' })
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      sinon.assert.notCalled(nativeSpans.setUseV05)
    })

    it('stays on v0.4 when /info fails', () => {
      config.protocolVersion = '0.5'
      fetchAgentInfo.callsArgWith(1, new Error('connection refused'))
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      sinon.assert.notCalled(nativeSpans.setUseV05)
    })

    it('does not fetch /info at all when protocol is not 0.5', () => {
      config.protocolVersion = '0.4'
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      sinon.assert.notCalled(fetchAgentInfo)
      sinon.assert.notCalled(nativeSpans.setUseV05)
    })
  })

  describe('OTLP export', () => {
    beforeEach(() => {
      config.OTEL_TRACES_EXPORTER = 'otlp'
      config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector:4318/v1/traces'
    })

    it('routes traces to the OTLP endpoint when OTEL_TRACES_EXPORTER=otlp', () => {
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      sinon.assert.calledOnceWithExactly(nativeSpans.setOtlpEndpoint, 'http://collector:4318/v1/traces')
      // No protocol/headers configured — the native defaults are used.
      sinon.assert.notCalled(nativeSpans.setOtlpProtocol)
      sinon.assert.notCalled(nativeSpans.setOtlpHeaders)
    })

    it('forwards the OTLP protocol and flattened headers', () => {
      config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'http/protobuf'
      config.OTEL_EXPORTER_OTLP_TRACES_HEADERS = { authorization: 'Bearer t', 'x-tenant': 'a' }
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      sinon.assert.calledOnceWithExactly(nativeSpans.setOtlpProtocol, 'http/protobuf')
      sinon.assert.calledOnceWithExactly(nativeSpans.setOtlpHeaders, ['authorization', 'Bearer t', 'x-tenant', 'a'])
    })

    it('takes precedence over v0.5 (no /info negotiation)', () => {
      config.protocolVersion = '0.5'
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      sinon.assert.calledOnce(nativeSpans.setOtlpEndpoint)
      sinon.assert.notCalled(fetchAgentInfo)
      sinon.assert.notCalled(nativeSpans.setUseV05)
    })

    it('tolerates an unsupported protocol (caught, falls back to default)', () => {
      config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'grpc'
      nativeSpans.setOtlpProtocol.throws(new Error('OTLP gRPC export is not supported'))

      // Construction must not throw — the unsupported protocol is caught and logged.
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      sinon.assert.calledOnce(nativeSpans.setOtlpEndpoint)
      // The fallback is observable as a warning.
      sinon.assert.calledOnce(logWarn)
    })

    it('does not configure OTLP when exporter is not otlp', () => {
      config.OTEL_TRACES_EXPORTER = 'none'
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      sinon.assert.notCalled(nativeSpans.setOtlpEndpoint)
    })

    it('does not call setOtlpHeaders for an empty headers map', () => {
      config.OTEL_EXPORTER_OTLP_TRACES_HEADERS = {}
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      sinon.assert.calledOnce(nativeSpans.setOtlpEndpoint)
      sinon.assert.notCalled(nativeSpans.setOtlpHeaders)
    })

    it('skips OTLP setup (and warns) when no endpoint is resolved', () => {
      config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = undefined
      // eslint-disable-next-line no-new
      new NativeExporter(config, prioritySampler, nativeSpans)
      sinon.assert.notCalled(nativeSpans.setOtlpEndpoint)
      sinon.assert.calledOnce(logWarn)
    })
  })

  describe('constructor', () => {
    it('should initialize config, pending spans, and register beforeExit', () => {
      // Constructor wires up immutable state — assert all of it in one shot
      // rather than splitting across three near-identical it() blocks. The
      // URL fallback path has its own test below since it has real branching.
      const ddTrace = globalThis[Symbol.for('dd-trace')]
      const beforeCount = ddTrace.beforeExitHandlers.size

      exporter = new NativeExporter(config, prioritySampler, nativeSpans)

      assert.strictEqual(exporter._config, config)
      assert.strictEqual(exporter._prioritySampler, prioritySampler)
      assert.strictEqual(exporter._nativeSpans, nativeSpans)
      assert.deepStrictEqual(exporter._pendingSpans, [])
      // Constructor should add to the shared registry rather than attaching
      // a fresh listener to `process` (which would leak under test reinit).
      assert.strictEqual(ddTrace.beforeExitHandlers.size, beforeCount + 1)
    })

    it('should derive URL from config.url, falling back to hostname:port', () => {
      // Two branches of the URL-derivation logic in one test: the happy path
      // (config.url provided) and the fallback (only hostname/port given).
      const fromUrl = new NativeExporter(config, prioritySampler, nativeSpans)
      assert.ok(fromUrl._url)

      const configWithHostname = {
        hostname: 'agent.example.com',
        port: 8127,
        flushInterval: 1000,
      }
      const fromHostname = new NativeExporter(configWithHostname, prioritySampler, nativeSpans)
      assert.ok(fromHostname._url.toString().includes('agent.example.com'))
    })
  })

  describe('export', () => {
    beforeEach(() => {
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    })

    it('should collect spans for batch export', () => {
      const span1 = createMockSpan(1n)
      const span2 = createMockSpan(2n)

      exporter.export([span1, span2])

      assert.strictEqual(exporter._pendingSpans.length, 2)
    })

    it('should flush immediately when flushInterval is 0', () => {
      exporter = new NativeExporter({ ...config, flushInterval: 0 }, prioritySampler, nativeSpans)

      const span = createMockSpan(1n)
      exporter.export([span])

      // The exporter doesn't call flushChangeQueue directly; the
      // change queue is drained inside flushSpansGrouped. Assert the visible
      // public-API call instead.
      sinon.assert.called(nativeSpans.flushSpansGrouped)
    })

    it('schedules exactly one flush timer after flushInterval ms regardless of repeated export() calls', () => {
      // Several export() calls within the same flushInterval window should
      // share one timer, not stack up — and no flush should fire until the
      // interval elapses.
      exporter.export([createMockSpan(1n)])
      clock.tick(config.flushInterval / 2)
      exporter.export([createMockSpan(2n)])
      clock.tick(config.flushInterval / 2 - 1)
      exporter.export([createMockSpan(3n)])

      sinon.assert.notCalled(nativeSpans.flushSpansGrouped)

      clock.tick(2)

      sinon.assert.calledOnce(nativeSpans.flushSpansGrouped)
    })
  })

  describe('flush', () => {
    beforeEach(() => {
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    })

    it('should do nothing if no pending spans', (done) => {
      exporter.flush(() => {
        sinon.assert.notCalled(nativeSpans.flushSpansGrouped)
        done()
      })
    })

    it('exposes a _writer.flush shim that delegates to flush() (parametric app compat)', (done) => {
      exporter._writer.flush(() => {
        sinon.assert.notCalled(nativeSpans.flushSpansGrouped)
        done()
      })
    })

    it('flushStats() force-flushes the native concentrator (parametric stats-flush)', async () => {
      const result = await exporter.flushStats()
      sinon.assert.calledOnce(nativeSpans.flushStats)
      assert.strictEqual(result, true)
      // stats are NOT flushed by the trace flush path (own 10s cadence)
      exporter._writer.flush(() => {})
      sinon.assert.calledOnce(nativeSpans.flushStats)
    })

    // The success path is one observable sequence — splitting it across 5
    // it() blocks paid for 5x mocha-overhead while testing the same flow.
    // This single test pins all five aspects: flushSpansGrouped is called with the
    // extracted slot indices, _pendingSpans drains, the done callback fires
    // with no error, and pending spans drain once the in-flight send settles.
    it('end-to-end successful flush: calls flushSpansGrouped with span ids, drains pending, fires done',
      async () => {
        const span1 = createMockSpan(123n)
        const span2 = createMockSpan(456n)
        exporter.export([span1, span2])

        // done() fires synchronously after flush() kicks off the async send.
        let cbErr = 'unset'
        exporter.flush((err) => { cbErr = err })
        assert.strictEqual(cbErr, undefined)

        // flushSpansGrouped called with the extracted span-id array — the native
        // pipeline addresses spans by their span id.
        sinon.assert.called(nativeSpans.flushSpansGrouped)
        // Two distinct traces -> two per-trace chunks; every span id is present.
        const groups = nativeSpans.flushSpansGrouped.getCall(0).args[0]
        const allIds = groups.flatMap(g => g.spanIds)
        assert.deepStrictEqual(allIds, [
          span1.context()._nativeSpanId,
          span2.context()._nativeSpanId,
        ])
        // Pending spans drain synchronously when the flush is dispatched.
        assert.strictEqual(exporter._pendingSpans.length, 0)

        // Drain microtasks so the resolved-flush handler runs.
        await clock.tickAsync(0)
      })

    it('sends one payload per trace at flushInterval:0 when a flush coalesced multiple traces',
      async () => {
        // flushInterval:0 mirrors the legacy AgentWriter's one-trace-per-request
        // behaviour. When several traces pile up during an in-flight send and
        // drain together, each must ship as its own payload so a `traces[0]`
        // consumer isn't handed a coalesced multi-trace payload.
        exporter = new NativeExporter({ ...config, flushInterval: 0 }, prioritySampler, nativeSpans)
        const span1 = createMockSpan(123n)
        const span2 = createMockSpan(456n)
        exporter.export([span1, span2])

        // Drain the sequenced per-group sends.
        await clock.tickAsync(0)
        await clock.tickAsync(0)

        sinon.assert.calledTwice(nativeSpans.flushSpansGrouped)
        assert.strictEqual(nativeSpans.flushSpansGrouped.getCall(0).args[0].length, 1)
        assert.strictEqual(nativeSpans.flushSpansGrouped.getCall(1).args[0].length, 1)
      })

    it('sends one batched payload at flushInterval:0 for a single trace', async () => {
      exporter = new NativeExporter({ ...config, flushInterval: 0 }, prioritySampler, nativeSpans)
      exporter.export([createMockSpan(1n)])
      await clock.tickAsync(0)
      sinon.assert.calledOnce(nativeSpans.flushSpansGrouped)
      assert.strictEqual(nativeSpans.flushSpansGrouped.getCall(0).args[0].length, 1)
    })

    it('should sync trace tags to first span', (done) => {
      const span = createMockSpan(1n)
      // Make this span a local root by setting parentId to null
      span.context()._parentId = null
      span.context()._trace.tags = { '_dd.p.tid': 'abc123' }
      exporter.export([span])

      exporter.flush(() => {
        // Trace tags should be synced to span tags
        assert.ok(span.context().getTag('_dd.p.tid'))
        done()
      })
    })

    it('should add process tags to local root span when flag is enabled', (done) => {
      // Reload exporter with process-tags mocked to return a known serialized value
      NativeExporter = proxyquire('../../src/exporters/native', {
        '../../log': { warn: sinon.stub(), error: sinon.stub() },
        '../../process-tags': {
          TRACING_FIELD_NAME: '_dd.tags.process',
          serialized: 'entrypoint.workdir:test,entrypoint.name:app,entrypoint.type:script',
        },
      })

      exporter = new NativeExporter({
        ...config,
        DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: true,
      }, prioritySampler, nativeSpans)

      const span = createMockSpan(1n)
      span.context()._parentId = null
      exporter.export([span])

      exporter.flush(() => {
        assert.strictEqual(
          span.context().getTag('_dd.tags.process'),
          'entrypoint.workdir:test,entrypoint.name:app,entrypoint.type:script'
        )
        done()
      })
    })

    it('should not add process tags when flag is disabled', (done) => {
      NativeExporter = proxyquire('../../src/exporters/native', {
        '../../log': { warn: sinon.stub(), error: sinon.stub() },
        '../../process-tags': {
          TRACING_FIELD_NAME: '_dd.tags.process',
          serialized: 'entrypoint.workdir:test,entrypoint.name:app',
        },
      })

      exporter = new NativeExporter({
        ...config,
        DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: false,
      }, prioritySampler, nativeSpans)

      const span = createMockSpan(1n)
      span.context()._parentId = null
      exporter.export([span])

      exporter.flush(() => {
        assert.strictEqual(span.context().getTag('_dd.tags.process'), undefined)
        done()
      })
    })

    it('should not add process tags when serialized is empty', (done) => {
      NativeExporter = proxyquire('../../src/exporters/native', {
        '../../log': { warn: sinon.stub(), error: sinon.stub() },
        '../../process-tags': {
          TRACING_FIELD_NAME: '_dd.tags.process',
          serialized: null,
        },
      })

      exporter = new NativeExporter({
        ...config,
        DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: true,
      }, prioritySampler, nativeSpans)

      const span = createMockSpan(1n)
      span.context()._parentId = null
      exporter.export([span])

      exporter.flush(() => {
        assert.strictEqual(span.context().getTag('_dd.tags.process'), undefined)
        done()
      })
    })

    it('should preserve existing _dd.tags.process tag on span', (done) => {
      NativeExporter = proxyquire('../../src/exporters/native', {
        '../../log': { warn: sinon.stub(), error: sinon.stub() },
        '../../process-tags': {
          TRACING_FIELD_NAME: '_dd.tags.process',
          serialized: 'entrypoint.workdir:test,entrypoint.name:app',
        },
      })

      exporter = new NativeExporter({
        ...config,
        DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: true,
      }, prioritySampler, nativeSpans)

      const span = createMockSpan(1n)
      span.context()._parentId = null
      span.context().setTag('_dd.tags.process', 'existing:tags')
      exporter.export([span])

      exporter.flush(() => {
        assert.strictEqual(span.context().getTag('_dd.tags.process'), 'existing:tags')
        done()
      })
    })

    it('should determine first is local root correctly for root span', (done) => {
      const span = createMockSpan(1n)
      span.context()._parentId = null
      exporter.export([span])

      exporter.flush(() => {
        const groups = nativeSpans.flushSpansGrouped.getCall(0).args[0]
        assert.strictEqual(groups.length, 1)
        assert.strictEqual(groups[0].firstIsLocalRoot, true)
        done()
      })
    })

    it('should re-flush pending spans after a flush rejection', async () => {
      // Asymmetric to the success-path drain. Without this, a single
      // transient agent failure would leave spans buffered indefinitely
      // until the next export() call woke the exporter back up.
      let rejectSend
      nativeSpans.flushSpansGrouped
        .onFirstCall().callsFake(() => new Promise((_resolve, reject) => { rejectSend = reject }))
        .onSecondCall().resolves('unchanged')

      exporter.export([createMockSpan(1n)])
      exporter.flush()
      exporter.export([createMockSpan(2n)])
      exporter.flush()
      assert.strictEqual(exporter._pendingSpans.length, 1)

      rejectSend(new Error('Network error'))
      await clock.tickAsync(0)
      await clock.tickAsync(0)

      sinon.assert.calledTwice(nativeSpans.flushSpansGrouped)
      assert.strictEqual(exporter._pendingSpans.length, 0)
    })

    it('disables the exporter on a fatal NativeExporterBuildError (no retry loop)', async () => {
      // A build failure (bad config) is fatal and one-shot; the exporter must
      // stop instead of looping on the same error every flush.
      const buildErr = new Error('native exporter build failed: invalid config')
      buildErr.name = 'NativeExporterBuildError'
      nativeSpans.flushSpansGrouped.rejects(buildErr)

      exporter.export([createMockSpan(1n)])
      exporter.flush()
      await clock.tickAsync(0)
      await clock.tickAsync(0)

      // Buffered spans dropped, and the exporter is now disabled.
      assert.strictEqual(exporter._pendingSpans.length, 0)
      sinon.assert.calledOnce(nativeSpans.flushSpansGrouped)

      // Subsequent export()/flush() are no-ops — no further send attempts.
      exporter.export([createMockSpan(2n)])
      exporter.flush()
      assert.strictEqual(exporter._pendingSpans.length, 0)
      sinon.assert.calledOnce(nativeSpans.flushSpansGrouped)
    })

    it('should not start a new flush while one is in flight', () => {
      // While the first flush()'s send is unresolved, a second flush()
      // call must not call into native again — the spans should accumulate
      // in `_pendingSpans` and drain after the in-flight settles.
      let resolveSend
      nativeSpans.flushSpansGrouped.callsFake(() => new Promise(resolve => { resolveSend = resolve }))

      exporter.export([createMockSpan(1n)])
      exporter.flush()
      sinon.assert.calledOnce(nativeSpans.flushSpansGrouped)

      // Second batch arrives while the first send is still in flight:
      exporter.export([createMockSpan(2n)])
      exporter.flush()
      sinon.assert.calledOnce(nativeSpans.flushSpansGrouped)
      assert.strictEqual(exporter._pendingSpans.length, 1)

      // Settle the in-flight send so afterEach's clock.restore() doesn't
      // leak an unhandled-rejection warning across tests.
      resolveSend('unchanged')
    })

    it('should re-flush queued spans after in-flight settles', async () => {
      // Spans queued during a send should drain on settle, not stay buffered.
      let resolveSend
      nativeSpans.flushSpansGrouped
        .onFirstCall().callsFake(() => new Promise(resolve => { resolveSend = resolve }))
        .onSecondCall().resolves('unchanged')

      exporter.export([createMockSpan(1n)])
      exporter.flush()
      exporter.export([createMockSpan(2n)])
      exporter.flush()
      assert.strictEqual(exporter._pendingSpans.length, 1)

      resolveSend('unchanged')
      // Drain the .then chain on the first send and the chained re-flush.
      await clock.tickAsync(0)
      await clock.tickAsync(0)

      sinon.assert.calledTwice(nativeSpans.flushSpansGrouped)
      assert.strictEqual(exporter._pendingSpans.length, 0)
    })

    it('should swallow flushSpansGrouped rejections (logged, not propagated to done)', async () => {
      // flush() calls done() immediately after kicking off the
      // async send, then log.error()s any rejection. Errors no longer
      // surface through the done callback. Verify done is invoked
      // without an argument and the rejection is observed (logged).
      nativeSpans.flushSpansGrouped.rejects(new Error('Network error'))

      const span = createMockSpan(1n)
      exporter.export([span])

      let cbErr = 'unset'
      exporter.flush((err) => { cbErr = err })
      assert.strictEqual(cbErr, undefined)

      // Drain pending microtasks so the rejection handler runs. With
      // sinon.useFakeTimers() Promise microtasks still settle when we yield
      // to the host promise queue via tickAsync.
      await clock.tickAsync(0)

      sinon.assert.called(logError)
    })
  })

  describe('agent sampling rates', () => {
    beforeEach(() => {
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    })

    it('forwards rate_by_service from the agent response to the priority sampler', async () => {
      const rates = { 'service:web,env:prod': 0.5, 'service:db,env:prod': 0.1 }
      nativeSpans.flushSpansGrouped.resolves(JSON.stringify({ rate_by_service: rates }))

      exporter.export([createMockSpan(1n)])
      exporter.flush()
      await clock.tickAsync(0)

      sinon.assert.calledOnceWithExactly(prioritySampler.update, rates)
    })

    it('does not update rates for sentinel responses (unchanged / no spans / empty)', async () => {
      // The native layer resolves 'unchanged' when the rates payload-version
      // header matches the previous flush, 'no spans to flush' when nothing
      // was sent, and these carry no body to parse. None should touch the
      // sampler or log an error.
      for (const sentinel of ['unchanged', 'no spans to flush', '']) {
        nativeSpans.flushSpansGrouped.resolves(sentinel)
        exporter.export([createMockSpan(1n)])
        exporter.flush()
        await clock.tickAsync(0)
      }

      sinon.assert.notCalled(prioritySampler.update)
      sinon.assert.notCalled(logError)
    })

    it('does not update rates when the response body omits rate_by_service', async () => {
      nativeSpans.flushSpansGrouped.resolves(JSON.stringify({ something_else: true }))

      exporter.export([createMockSpan(1n)])
      exporter.flush()
      await clock.tickAsync(0)

      sinon.assert.notCalled(prioritySampler.update)
    })

    it('swallows malformed JSON in the response without disrupting the flush', async () => {
      nativeSpans.flushSpansGrouped.resolves('this is not json')

      exporter.export([createMockSpan(1n)])
      exporter.flush()
      await clock.tickAsync(0)

      // No throw, sampler untouched, error logged.
      sinon.assert.notCalled(prioritySampler.update)
      sinon.assert.calledOnce(logError)
    })
  })

  describe('first-flush channel', () => {
    const firstFlushChannel = channel('dd-trace:exporter:first-flush')
    let onFirstFlush

    beforeEach(() => {
      onFirstFlush = sinon.spy()
      firstFlushChannel.subscribe(onFirstFlush)
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    })

    afterEach(() => {
      firstFlushChannel.unsubscribe(onFirstFlush)
    })

    it('publishes once on first successful flush and does not republish on subsequent flushes', async () => {
      exporter.export([createMockSpan(1n)])
      exporter.flush()
      await clock.tickAsync(0)
      sinon.assert.calledOnce(onFirstFlush)

      exporter.export([createMockSpan(2n)])
      exporter.flush()
      await clock.tickAsync(0)
      sinon.assert.calledOnce(onFirstFlush)
    })

    it('does not publish when the flush rejects', async () => {
      nativeSpans.flushSpansGrouped.rejects(new Error('Network error'))

      exporter.export([createMockSpan(1n)])
      exporter.flush()
      await clock.tickAsync(0)

      sinon.assert.notCalled(onFirstFlush)
    })
  })

  describe('setUrl', () => {
    beforeEach(() => {
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    })

    it('should update the URL', () => {
      const originalUrl = exporter._url.toString()
      exporter.setUrl('http://new-agent:9999')

      assert.notStrictEqual(exporter._url.toString(), originalUrl)
    })
  })

  describe('health metrics', () => {
    const P = 'datadog.tracer.node.exporter.agent'

    it('increments request + response counters on a successful flush', async () => {
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)
      exporter.export([createMockSpan(1n)])
      exporter.flush(() => {})
      await clock.tickAsync(0)
      sinon.assert.calledWith(metricsIncrement, `${P}.requests`, true)
      sinon.assert.calledWith(metricsIncrement, `${P}.responses`, true)
    })

    it('increments error counters (name + code) on a failed flush', async () => {
      const err = new Error('boom')
      err.code = 'ECONNREFUSED'
      nativeSpans.flushSpansGrouped.rejects(err)
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)
      exporter.export([createMockSpan(1n)])
      exporter.flush(() => {})
      await clock.tickAsync(0)
      sinon.assert.calledWith(metricsIncrement, `${P}.requests`, true)
      sinon.assert.calledWith(metricsIncrement, `${P}.errors`, true)
      sinon.assert.calledWith(metricsIncrement, `${P}.errors.by.name`, 'name:Error', true)
      sinon.assert.calledWith(metricsIncrement, `${P}.errors.by.code`, 'code:ECONNREFUSED', true)
    })
  })

  // Helper function to create mock spans
  function createMockSpan (nativeSpanIdValue) {
    // Create an 8-byte buffer for the span ID (big-endian)
    const nativeSpanId = Buffer.alloc(8)
    nativeSpanId.writeBigUInt64BE(BigInt(nativeSpanIdValue))

    const spanId = {
      toString: () => String(nativeSpanIdValue),
      toBigInt: () => BigInt(nativeSpanIdValue),
      toBuffer: () => nativeSpanId,
    }

    const tagStore = Object.create(null)

    const context = {
      _nativeSpanId: nativeSpanId,
      _spanId: spanId,
      _parentId: { toString: () => '0' },
      _isRemote: false,
      // The exporter reads context._nativeSpanId to build the span-id
      // array passed to nativeSpans.flushSpansGrouped.
      _trace: {
        started: [],
        finished: [],
        tags: {},
      },
      hasTag (key) {
        return key in tagStore
      },
      setTag (key, value) {
        tagStore[key] = value
      },
      getTag (key) {
        return tagStore[key]
      },
    }

    return {
      context: () => context,
    }
  }
})
