'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')

require('../setup/core')

const baseOptions = {
  agentUrl: 'http://localhost:8126',
  tracerVersion: '1.0.0',
  lang: 'nodejs',
  langVersion: 'v20.0.0',
  langInterpreter: 'v8',
  pid: 12345,
  tracerService: 'test-service',
}
const encodedPayload = Buffer.from([0xDD, 0, 0, 0, 1, 0xDD, 0, 0, 0, 0])

function deferred () {
  let resolveOperation
  let rejectOperation
  const promise = new Promise((resolve, reject) => {
    resolveOperation = resolve
    rejectOperation = reject
  })
  return { promise, reject: rejectOperation, resolve: resolveOperation }
}

function createState () {
  return {
    flushStats: sinon.stub().resolves(true),
    free: sinon.stub(),
    sendEncodedTraces: sinon.stub().resolves('OK'),
    setAgentlessEndpoint: sinon.stub(),
    setOtlpEndpoint: sinon.stub(),
    setOtlpHeaders: sinon.stub(),
    setOtlpProtocol: sinon.stub(),
    setUseV05: sinon.stub(),
  }
}

describe('NativeSpansInterface', () => {
  let NativeSpansInterface
  let WasmSpanState
  let logError
  let metricsCount
  let states

  /**
   * @param {object} [options]
   * @returns {import('../../src/native/native-spans')}
   */
  function createInterface (options = {}) {
    return new NativeSpansInterface({ ...baseOptions, ...options })
  }

  beforeEach(() => {
    states = []
    WasmSpanState = sinon.stub().callsFake(() => {
      const state = createState()
      states.push(state)
      return state
    })
    logError = sinon.stub()
    metricsCount = sinon.stub()
    NativeSpansInterface = proxyquire('../../src/native/native-spans', {
      './index': { WasmSpanState },
      '../log': { debug: sinon.stub(), error: logError },
      '../runtime_metrics': { count: metricsCount },
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  it('constructs the binding state without allocating unused transfer buffers', () => {
    createInterface()

    sinon.assert.calledOnce(WasmSpanState)
    assert.deepStrictEqual(WasmSpanState.firstCall.args, [
      'http://localhost:8126',
      '1.0.0',
      'nodejs',
      'v20.0.0',
      'v8',
      8,
      0,
      12345,
      'test-service',
      false,
      '',
      '',
      '',
      '',
      false,
    ])
  })

  it('uses runtime defaults for omitted binding metadata', () => {
    createInterface({
      lang: undefined,
      langVersion: undefined,
      langInterpreter: undefined,
      pid: undefined,
    })

    assert.deepStrictEqual(WasmSpanState.firstCall.args, [
      'http://localhost:8126',
      '1.0.0',
      'nodejs',
      process.version,
      'v8',
      8,
      0,
      process.pid,
      'test-service',
      false,
      '',
      '',
      '',
      '',
      false,
    ])
  })

  it('rejects a binding without encoded-trace support and frees its state', () => {
    const state = createState()
    state.sendEncodedTraces = undefined
    WasmSpanState.returns(state)

    assert.throws(() => createInterface(), /pipeline is missing sendEncodedTraces/)
    sinon.assert.calledOnce(state.free)
  })

  it('rejects when the native pipeline is unavailable', () => {
    NativeSpansInterface = proxyquire('../../src/native/native-spans', {
      './index': { WasmSpanState: undefined },
      '../log': { debug: sinon.stub(), error: logError },
      '../runtime_metrics': { count: metricsCount },
    })

    assert.throws(() => createInterface(), /Native spans module is not available/)
  })

  it('transfers the encoded payload to the binding unchanged', async () => {
    const nativeSpans = createInterface()

    assert.strictEqual(await nativeSpans.sendEncodedTraces(encodedPayload), 'OK')
    sinon.assert.calledOnceWithExactly(states[0].sendEncodedTraces, encodedPayload)
  })

  it('does not call the stats API when stats are disabled', async () => {
    const nativeSpans = createInterface()

    assert.strictEqual(await nativeSpans.flushStats(), true)
    sinon.assert.notCalled(states[0].flushStats)
  })

  it('force-flushes stats and reports collapsed spans', async () => {
    const nativeSpans = createInterface({ statsEnabled: true })
    states[0].flushStats.resolves({ sent: true, collapsedSpans: 3 })

    assert.strictEqual(await nativeSpans.flushStats(), true)
    sinon.assert.calledOnceWithExactly(states[0].flushStats, true)
    sinon.assert.calledOnceWithExactly(
      metricsCount,
      'datadog.tracer.stats.collapsed_spans',
      3,
      'collapsed_spans:whole_key',
      true,
    )
  })

  it('flushes periodic stats without forcing partial buckets', async () => {
    const clock = sinon.useFakeTimers()
    createInterface({ statsEnabled: true })
    states[0].flushStats.resolves({ sent: false, collapsedSpans: 2 })

    await clock.tickAsync(10_000)

    sinon.assert.calledOnceWithExactly(states[0].flushStats, false)
    sinon.assert.calledOnceWithExactly(
      metricsCount,
      'datadog.tracer.stats.collapsed_spans',
      2,
      'collapsed_spans:whole_key',
      true,
    )
  })

  it('logs a rejected periodic stats flush', async () => {
    const clock = sinon.useFakeTimers()
    const error = new Error('stats failed')
    createInterface({ statsEnabled: true })
    states[0].flushStats.rejects(error)

    await clock.tickAsync(10_000)

    sinon.assert.calledOnceWithExactly(logError, 'Error flushing native stats: %s', error)
  })

  it('logs a synchronous periodic stats flush failure', async () => {
    const clock = sinon.useFakeTimers()
    const error = new Error('stats failed')
    createInterface({ statsEnabled: true })
    states[0].flushStats.throws(error)

    await clock.tickAsync(10_000)

    sinon.assert.calledOnceWithExactly(logError, 'Error flushing native stats: %s', error)
  })

  it('rejects a synchronous forced stats flush failure', async () => {
    const error = new Error('stats failed')
    const nativeSpans = createInterface({ statsEnabled: true })
    states[0].flushStats.throws(error)

    await assert.rejects(nativeSpans.flushStats(), error)
  })

  it('replays successful native configuration when the agent URL changes', () => {
    const nativeSpans = createInterface()
    nativeSpans.setUseV05(true)
    nativeSpans.setOtlpEndpoint('http://collector:4318/v1/traces')
    nativeSpans.setOtlpProtocol('http/protobuf')
    const headers = ['authorization', 'secret']
    nativeSpans.setOtlpHeaders(headers)
    headers[1] = 'changed'

    nativeSpans.setAgentUrl('http://new-agent:8126')

    assert.strictEqual(WasmSpanState.secondCall.args[0], 'http://new-agent:8126')
    sinon.assert.calledOnceWithExactly(states[1].setUseV05, true)
    sinon.assert.calledOnceWithExactly(states[1].setOtlpEndpoint, 'http://collector:4318/v1/traces')
    sinon.assert.calledOnceWithExactly(states[1].setOtlpProtocol, 'http/protobuf')
    sinon.assert.calledOnceWithExactly(states[1].setOtlpHeaders, ['authorization', 'secret'])
    sinon.assert.calledOnce(states[0].free)
  })

  it('replays agentless configuration when native state is replaced', () => {
    const nativeSpans = createInterface()
    nativeSpans.setAgentlessEndpoint('https://intake.example/api/v2/spans', 'test-api-key')

    nativeSpans.setAgentUrl('http://new-agent:8126')

    sinon.assert.calledOnceWithExactly(
      states[1].setAgentlessEndpoint,
      'https://intake.example/api/v2/spans',
      'test-api-key',
    )
    sinon.assert.calledOnce(states[0].free)
  })

  it('replaces native state when the agentless endpoint changes', () => {
    const nativeSpans = createInterface()
    nativeSpans.setAgentlessEndpoint('https://first.example/api/v2/spans', 'first-key')

    nativeSpans.setAgentlessEndpoint('https://second.example/api/v2/spans', 'second-key')

    sinon.assert.calledOnceWithExactly(
      states[1].setAgentlessEndpoint,
      'https://second.example/api/v2/spans',
      'second-key',
    )
    sinon.assert.calledOnce(states[0].free)
  })

  it('keeps the active agentless state when replacement configuration fails', async () => {
    const error = new Error('invalid replacement rule')
    const nativeSpans = createInterface()
    nativeSpans.setAgentlessEndpoint('https://first.example/api/v2/spans', 'first-key')
    const replacement = createState()
    replacement.setAgentlessEndpoint.throws(error)
    WasmSpanState.onSecondCall().returns(replacement)

    assert.throws(
      () => nativeSpans.setAgentlessEndpoint('https://second.example/api/v2/spans', 'second-key'),
      error,
    )
    sinon.assert.calledOnce(replacement.free)
    sinon.assert.notCalled(states[0].free)
    assert.strictEqual(await nativeSpans.sendEncodedTraces(encodedPayload), 'OK')

    nativeSpans.setAgentUrl('http://new-agent:8126')
    sinon.assert.calledOnceWithExactly(
      states[1].setAgentlessEndpoint,
      'https://first.example/api/v2/spans',
      'first-key',
    )
  })

  it('keeps the old state until all of its asynchronous operations settle', async () => {
    const traceSend = deferred()
    const statsFlush = deferred()
    const nativeSpans = createInterface({ statsEnabled: true })
    states[0].sendEncodedTraces.returns(traceSend.promise)
    states[0].flushStats.returns(statsFlush.promise)

    const send = nativeSpans.sendEncodedTraces(encodedPayload)
    const flush = nativeSpans.flushStats()
    nativeSpans.setAgentUrl('http://new-agent:8126')
    sinon.assert.notCalled(states[0].free)

    traceSend.resolve('OK')
    await send
    sinon.assert.notCalled(states[0].free)

    statsFlush.resolve(true)
    await flush
    sinon.assert.calledOnce(states[0].free)
  })

  it('releases a retired state after a rejected operation', async () => {
    const traceSend = deferred()
    const error = new Error('send failed')
    const nativeSpans = createInterface()
    states[0].sendEncodedTraces.returns(traceSend.promise)

    const send = assert.rejects(nativeSpans.sendEncodedTraces(encodedPayload), error)
    nativeSpans.setAgentUrl('http://new-agent:8126')
    traceSend.reject(error)

    await send
    sinon.assert.calledOnce(states[0].free)
  })

  it('keeps the active state when replacement configuration fails', async () => {
    const error = new Error('invalid endpoint')
    const nativeSpans = createInterface()
    nativeSpans.setOtlpEndpoint('http://collector:4318/v1/traces')
    const replacement = createState()
    replacement.setOtlpEndpoint.throws(error)
    WasmSpanState.onSecondCall().returns(replacement)

    assert.throws(() => nativeSpans.setAgentUrl('http://new-agent:8126'), error)
    sinon.assert.calledOnce(replacement.free)
    sinon.assert.notCalled(states[0].free)
    assert.strictEqual(await nativeSpans.sendEncodedTraces(encodedPayload), 'OK')
    sinon.assert.calledOnce(states[0].sendEncodedTraces)
  })

  it('does not persist native configuration that the binding rejects', () => {
    const error = new Error('unsupported protocol')
    const nativeSpans = createInterface()
    states[0].setOtlpProtocol.throws(error)

    assert.throws(() => nativeSpans.setOtlpProtocol('grpc'), error)
    nativeSpans.setAgentUrl('http://new-agent:8126')

    sinon.assert.notCalled(states[1].setOtlpProtocol)
  })

  it('normalizes agent URLs at construction and replacement', () => {
    const cases = [
      ['unix:///var/run/datadog/apm.socket', 'unix:///var/run/datadog/apm.socket'],
      ['unix://./pipe/datadog-apm', 'windows://./pipe/datadog-apm'],
      ['windows://./pipe/datadog-apm', 'windows://./pipe/datadog-apm'],
      ['https://agent.example:8126', 'https://agent.example:8126'],
    ]

    for (const [input, expected] of cases) {
      const nativeSpans = createInterface({ agentUrl: input })
      assert.strictEqual(WasmSpanState.lastCall.args[0], expected)
      nativeSpans.setAgentUrl(input)
      assert.strictEqual(WasmSpanState.lastCall.args[0], expected)
    }
  })
})
