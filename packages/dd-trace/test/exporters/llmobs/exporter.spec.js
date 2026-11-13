'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

const { getConfigFresh } = require('../../helpers/config')

describe('LLMObsExporter', () => {
  let AgentExporter
  let AgentlessExporter
  let agentExporter
  let agentlessExporter
  let fetchAgentInfo
  let getValueFromEnvSources
  let logger
  let Exporter

  beforeEach(() => {
    agentExporter = {
      _url: new URL('http://agent:8126'),
      export: sinon.stub().returns(true),
      flush: sinon.stub().callsFake(done => done?.()),
      setUrl: sinon.stub(),
    }
    agentlessExporter = {
      _url: new URL('https://intake.example'),
      export: sinon.stub().returns(true),
      flush: sinon.stub().callsFake(done => done?.()),
      setUrl: sinon.stub(),
    }
    AgentExporter = sinon.stub().returns(agentExporter)
    AgentlessExporter = sinon.stub().returns(agentlessExporter)
    fetchAgentInfo = sinon.stub()
    getValueFromEnvSources = sinon.stub().returns(undefined)
    logger = { warn: sinon.stub() }

    Exporter = proxyquire('../../../src/exporters/llmobs', {
      '../../agent/info': { fetchAgentInfo },
      '../../config/helper': { getValueFromEnvSources },
      '../../log': logger,
      '../agent': AgentExporter,
      '../agentless': AgentlessExporter,
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  function getConfig () {
    return {
      tracing: { DD_TRACE_EXPERIMENTAL_EXPORTER: undefined },
      llmobs: { DD_LLMOBS_AGENTLESS_ENABLED: undefined },
      url: new URL('http://agent:8126'),
    }
  }

  describe('client stats ownership', () => {
    for (const selection of ['agentless', 'agent', 'discovery-agentless', 'discovery-agent']) {
      for (const otlp of [false, true]) {
        it(`uses one stats processor for ${selection} with OTLP metrics ${otlp}`, () => {
          const clock = sinon.useFakeTimers()
          const handlers = globalThis[Symbol.for('dd-trace')].beforeExitHandlers
          const originalHandlers = new Set(handlers)
          try {
            const config = getConfigFresh({ service: 'stats-test', flushInterval: 0 })
            config.llmobs.DD_LLMOBS_ENABLED = true
            config.llmobs.DD_LLMOBS_AGENTLESS_ENABLED = undefined
            config.tracing.DD_TRACE_EXPERIMENTAL_EXPORTER = selection.startsWith('discovery') ? undefined : selection
            config.stats.DD_TRACE_STATS_COMPUTATION_ENABLED = true
            config.OTEL_TRACES_SPAN_METRICS_ENABLED = otlp
            config.DD_API_KEY = 'test-api-key'
            const jsStats = { export: sinon.stub().callsFake((payload, done) => done?.()) }
            const otlpStats = {
              protocol: 'http/protobuf',
              getStartupResourceAttributes: () => ({}),
              export: sinon.stub().callsFake((payload, bucketSize, done) => done?.()),
              flush: sinon.stub().callsFake(done => done?.()),
            }
            const native = {
              sendV04: sinon.stub().callsFake((payload, done) => done()),
              flush: sinon.stub().callsFake(done => done?.()),
              close: sinon.stub(),
            }
            const createAgentlessExporter = sinon.stub().returns(native)
            const Writer = proxyquire('../../../src/exporters/agentless/writer', {
              '@datadog/libdatadog': { createAgentlessExporter },
              '../../config': () => config,
            })
            const NativeExporter = proxyquire('../../../src/exporters/agentless', { './writer': Writer })
            const agentWriter = {
              append: sinon.stub().returns(true),
              flush: sinon.stub().callsFake(done => done?.()),
            }
            const LocalExporter = proxyquire('../../../src/exporters/agent', {
              './writer': sinon.stub().returns(agentWriter),
            })
            const Stats = proxyquire('../../../src/span_stats', {
              './exporters/span-stats': { SpanStatsExporter: sinon.stub().returns(jsStats) },
            })
            const Processor = proxyquire('../../../src/span_processor', { './span_stats': Stats })
            const WrappedExporter = proxyquire('../../../src/exporters/llmobs', {
              '../../agent/info': { fetchAgentInfo },
              '../../config/helper': { getValueFromEnvSources },
              '../agent': LocalExporter,
              '../agentless': NativeExporter,
            })
            const selectExporter = sinon.stub().returns(WrappedExporter)
            const Tracer = proxyquire('../../../src/opentracing/tracer', {
              '../exporter': selectExporter,
              '../span_processor': Processor,
              '../opentelemetry/metrics': { createOtlpSpanStatsExporter: () => otlpStats },
            })
            const tracer = new Tracer(config)
            tracer.startSpan('before-selection').finish()
            if (selection.startsWith('discovery')) {
              fetchAgentInfo.yield(selection === 'discovery-agentless' ? new Error('Agent unavailable') : null)
            }
            tracer.startSpan('after-selection').finish()
            tracer._exporter.flush()
            clock.tick(10_000)

            const agentless = selection.endsWith('agentless')
            if (agentless || otlp) {
              sinon.assert.notCalled(jsStats.export)
            } else {
              sinon.assert.calledOnce(jsStats.export)
              assert.strictEqual(jsStats.export.firstCall.args[0].Stats[0].Stats.length, 2)
            }
            if (otlp) {
              sinon.assert.calledOnce(otlpStats.export)
              assert.strictEqual(otlpStats.export.firstCall.args[0][0].bucket.size, 2)
            } else {
              sinon.assert.notCalled(otlpStats.export)
            }
            if (agentless) {
              sinon.assert.calledOnce(createAgentlessExporter)
              assert.strictEqual(Boolean(createAgentlessExporter.firstCall.args[0].stats), !otlp)
              sinon.assert.calledTwice(native.sendV04)
            }
            sinon.assert.calledOnceWithExactly(selectExporter, 'llmobs')
          } finally {
            for (const handler of handlers) {
              if (!originalHandlers.has(handler)) handlers.delete(handler)
            }
            clock.restore()
          }
        })
      }
    }
  })

  it('buffers traces and drains them to the Agent exporter when discovery succeeds', () => {
    const config = getConfig()
    const prioritySampler = {}
    const exporter = new Exporter(config, prioritySampler)
    const trace = [{ name: 'llm.request' }]

    assert.strictEqual(exporter.export(trace), true)
    sinon.assert.notCalled(AgentExporter)
    sinon.assert.calledOnceWithExactly(getValueFromEnvSources, 'DD_AGENTLESS_ENABLED', true)
    sinon.assert.calledOnceWithExactly(fetchAgentInfo, config.url, sinon.match.func, { keepProcessAlive: true })

    fetchAgentInfo.yield(null, { endpoints: [] })

    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(agentExporter.export, trace)
    sinon.assert.notCalled(AgentlessExporter)
  })

  it('buffers traces and drains them to the agentless exporter when discovery fails', () => {
    const config = getConfig()
    const prioritySampler = {}
    const exporter = new Exporter(config, prioritySampler)
    const trace = [{
      name: 'llm.request',
      meta_struct: {
        _llmobs: {
          tags: {
            'customer.tier': 'gold',
            'ddtrace.version': '1.0.0',
            service: 'test',
          },
        },
      },
    }]

    exporter.export(trace)
    fetchAgentInfo.yield(new Error('Agent unavailable'))

    sinon.assert.calledOnceWithExactly(AgentlessExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(agentlessExporter.export, trace)
    assert.deepStrictEqual(trace[0].meta_struct._llmobs.tags, {
      customer_tier: 'gold',
      ddtrace_version: '1.0.0',
      service: 'test',
    })
    sinon.assert.notCalled(agentlessExporter.setUrl)
    sinon.assert.notCalled(AgentExporter)
  })

  it('limits the buffer by span count and evicts the oldest whole trace chunks', () => {
    const exporter = new Exporter(getConfig(), {})
    const oldestTrace = Array.from({ length: 300 }, () => ({}))
    const retainedTrace1 = Array.from({ length: 400 }, () => ({}))
    const retainedTrace2 = Array.from({ length: 300 }, () => ({}))
    const newestTrace = Array.from({ length: 250 }, () => ({}))

    exporter.export(oldestTrace)
    exporter.export(retainedTrace1)
    exporter.export(retainedTrace2)
    assert.strictEqual(exporter.export(newestTrace), true)
    fetchAgentInfo.yield(null, { endpoints: [] })

    sinon.assert.callCount(agentExporter.export, 3)
    assert.strictEqual(agentExporter.export.getCall(0).args[0], retainedTrace1)
    assert.strictEqual(agentExporter.export.getCall(1).args[0], retainedTrace2)
    assert.strictEqual(agentExporter.export.getCall(2).args[0], newestTrace)
    sinon.assert.calledOnceWithExactly(
      logger.warn,
      'LLMObs exporter trace buffer full (limit is %d spans), dropping trace data',
      1000
    )
  })

  it('drops a trace chunk that cannot fit in an empty buffer', () => {
    const exporter = new Exporter(getConfig(), {})
    const retainedTrace = [{ name: 'retained' }]
    const oversizedTrace = Array.from({ length: 1001 }, () => ({}))

    exporter.export(retainedTrace)
    assert.strictEqual(exporter.export(oversizedTrace), false)
    fetchAgentInfo.yield(null, { endpoints: [] })

    sinon.assert.calledOnceWithExactly(agentExporter.export, retainedTrace)
    sinon.assert.calledOnce(logger.warn)
  })

  it('buffers a trace chunk at the exact span limit', () => {
    const exporter = new Exporter(getConfig(), {})
    const trace = Array.from({ length: 1000 }, () => ({}))

    assert.strictEqual(exporter.export(trace), true)
    fetchAgentInfo.yield(null, { endpoints: [] })

    sinon.assert.calledOnceWithExactly(agentExporter.export, trace)
    sinon.assert.notCalled(logger.warn)
  })

  it('preserves dotted tag keys when using the Agent exporter', () => {
    const config = getConfig()
    const exporter = new Exporter(config, {})
    const trace = [{ meta_struct: { _llmobs: { tags: { 'customer.tier': 'gold' } } } }]

    exporter.export(trace)
    fetchAgentInfo.yield(null, { endpoints: [] })

    assert.deepStrictEqual(trace[0].meta_struct._llmobs.tags, { 'customer.tier': 'gold' })
    sinon.assert.calledOnceWithExactly(agentExporter.export, trace)
  })

  it('uses the LLMObs-specific agentless setting when global agentless mode is not configured', () => {
    const config = getConfig()
    config.llmobs.DD_LLMOBS_AGENTLESS_ENABLED = true
    const exporter = new Exporter(config, {})

    exporter.export([{ name: 'llm.request' }])

    sinon.assert.calledOnce(AgentlessExporter)
    sinon.assert.notCalled(fetchAgentInfo)
    sinon.assert.notCalled(AgentExporter)
  })

  for (const globalAgentless of [undefined, false, true]) {
    it(`honors the agentless exporter when global agentless is ${globalAgentless}`, () => {
      getValueFromEnvSources.returns(globalAgentless)
      const config = getConfig()
      config.tracing.DD_TRACE_EXPERIMENTAL_EXPORTER = 'agentless'
      config.llmobs.DD_LLMOBS_AGENTLESS_ENABLED = false

      const exporter = new Exporter(config, {})
      const trace = [{ name: 'llm.request' }]

      exporter.export(trace)

      sinon.assert.calledOnce(AgentlessExporter)
      sinon.assert.calledOnceWithExactly(agentlessExporter.export, trace)
      sinon.assert.notCalled(AgentExporter)
      sinon.assert.notCalled(fetchAgentInfo)
    })
  }

  it('uses the LLMObs-specific Agent setting when global agentless mode is not configured', () => {
    const config = getConfig()
    config.llmobs.DD_LLMOBS_AGENTLESS_ENABLED = false
    const exporter = new Exporter(config, {})

    exporter.export([{ name: 'llm.request' }])

    sinon.assert.calledOnce(AgentExporter)
    sinon.assert.notCalled(fetchAgentInfo)
    sinon.assert.notCalled(AgentlessExporter)
  })

  it('honors an explicit Agent exporter when LLMObs agentless mode is enabled', () => {
    const config = getConfig()
    config.tracing.DD_TRACE_EXPERIMENTAL_EXPORTER = 'agent'
    config.llmobs.DD_LLMOBS_AGENTLESS_ENABLED = true
    const prioritySampler = {}
    const exporter = new Exporter(config, prioritySampler)
    const trace = [{ name: 'llm.request' }]

    exporter.export(trace)

    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(agentExporter.export, trace)
    sinon.assert.notCalled(AgentlessExporter)
    sinon.assert.notCalled(fetchAgentInfo)
  })

  for (const agentlessEnabled of [undefined, false, true]) {
    it(`preserves LLMObs transport selection ${agentlessEnabled} with an empty exporter setting`, () => {
      const config = getConfig()
      config.tracing.DD_TRACE_EXPERIMENTAL_EXPORTER = ''
      config.llmobs.DD_LLMOBS_AGENTLESS_ENABLED = agentlessEnabled
      const exporter = new Exporter(config, {})
      const trace = [{ name: 'llm.request' }]

      exporter.export(trace)

      if (agentlessEnabled === undefined) {
        sinon.assert.calledOnce(fetchAgentInfo)
        sinon.assert.notCalled(AgentExporter)
        sinon.assert.notCalled(AgentlessExporter)
        fetchAgentInfo.yield(new Error('Agent unavailable'))
      } else {
        sinon.assert.notCalled(fetchAgentInfo)
      }

      const selectedExporter = agentlessEnabled === false ? agentExporter : agentlessExporter
      sinon.assert.calledOnceWithExactly(selectedExporter.export, trace)
    })
  }

  it('uses the agentless exporter immediately when global agentless mode is explicitly enabled', () => {
    getValueFromEnvSources.returns(true)
    const config = getConfig()
    config.llmobs.DD_LLMOBS_AGENTLESS_ENABLED = false
    const prioritySampler = {}
    const exporter = new Exporter(config, prioritySampler)
    const trace = [{ name: 'llm.request' }]

    exporter.export(trace)

    sinon.assert.calledOnceWithExactly(AgentlessExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(agentlessExporter.export, trace)
    sinon.assert.notCalled(fetchAgentInfo)
    sinon.assert.notCalled(AgentExporter)
  })

  it('uses the Agent exporter immediately when global agentless mode is explicitly disabled', () => {
    getValueFromEnvSources.returns(false)
    const config = getConfig()
    config.llmobs.DD_LLMOBS_AGENTLESS_ENABLED = true
    const prioritySampler = {}
    const exporter = new Exporter(config, prioritySampler)
    const trace = [{ name: 'llm.request' }]

    exporter.export(trace)

    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(agentExporter.export, trace)
    sinon.assert.notCalled(fetchAgentInfo)
    sinon.assert.notCalled(AgentlessExporter)
  })

  it('applies a URL set before transport selection to the selected exporter', () => {
    const exporter = new Exporter(getConfig(), {})
    const url = new URL('http://custom-agent:8126')

    exporter.setUrl(url)
    fetchAgentInfo.yield(null, { endpoints: [] })

    sinon.assert.calledOnceWithExactly(agentExporter.setUrl, url)
  })

  it('waits for transport selection before completing a flush', () => {
    const exporter = new Exporter(getConfig(), {})
    const trace = [{ name: 'llm.request' }]
    const done = sinon.spy()

    exporter.export(trace)
    exporter.flush(done)

    sinon.assert.notCalled(done)
    sinon.assert.notCalled(agentExporter.flush)

    fetchAgentInfo.yield(null, { endpoints: [] })

    sinon.assert.callOrder(agentExporter.export, agentExporter.flush)
    sinon.assert.calledOnceWithExactly(agentExporter.flush, done)
    sinon.assert.calledOnce(done)
  })
})
