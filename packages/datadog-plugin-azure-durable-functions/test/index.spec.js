'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../dd-trace/test/setup/core')

const { AUTO_KEEP, USER_KEEP } = require('../../../ext/priority')
const AzureDurableFunctionsPlugin = require('../src')

describe('azure-durable-functions plugin', () => {
  let plugin
  let extract
  let startSpan
  let setPriority
  let sampling
  let span

  beforeEach(() => {
    setPriority = sinon.stub()
    sampling = { priority: 0, mechanism: 3 }
    span = {
      context: sinon.stub().returns({ _sampling: sampling }),
      _prioritySampler: { setPriority },
      setTag: sinon.stub(),
    }

    extract = sinon.stub()
    startSpan = sinon.stub().returns(span)

    plugin = new AzureDurableFunctionsPlugin({
      extract,
      startSpan,
      _config: { DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT: 'continue' },
      _service: 'test-service',
      _nomenclature: {
        opName: () => 'azure.functions.invoke',
        serviceName: () => ({ name: 'test-service' }),
      },
    })
    plugin.configure({})
  })

  afterEach(() => {
    sinon.restore()
  })

  function bindStart (overrides = {}) {
    const ctx = {
      trigger: 'Activity',
      functionName: 'hola',
      currentStore: {},
      ...overrides,
    }

    plugin.bindStart(ctx)
    return ctx
  }

  it('continues the host trace when traceparent is provided', () => {
    const parent = { _traceId: 'parent' }
    extract.returns(parent)

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'dd=s:1',
    })

    sinon.assert.calledOnce(extract)
    const carrier = extract.firstCall.args[1]
    assert.strictEqual(carrier.traceparent, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
    assert.strictEqual(carrier.tracestate, 'dd=s:1')
    sinon.assert.calledWith(
      startSpan,
      'azure.functions.invoke',
      sinon.match({ childOf: parent })
    )
  })

  it('normalizes a failed extract to undefined childOf', () => {
    extract.returns(null)

    bindStart({
      traceparent: 'not-a-valid-traceparent',
    })

    sinon.assert.calledWith(
      startSpan,
      'azure.functions.invoke',
      sinon.match({ childOf: undefined })
    )
  })

  it('does not extract when traceparent is missing', () => {
    bindStart()

    sinon.assert.notCalled(extract)
    sinon.assert.calledWith(
      startSpan,
      'azure.functions.invoke',
      sinon.match({ childOf: undefined })
    )
  })

  it('tags entity operation metadata when operationName is present', () => {
    bindStart({
      trigger: 'Entity',
      functionName: 'counter',
      operationName: 'add_n',
    })

    sinon.assert.calledWith(span.setTag, 'aas.function.operation', 'add_n')
    sinon.assert.calledWith(span.setTag, 'resource.name', 'Entity counter add_n')
  })

  it('re-applies propagated keep when the host cleared the sampled flag', () => {
    extract.returns({ _traceId: 'parent' })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:1',
    })

    assert.strictEqual(sampling.priority, AUTO_KEEP)
    assert.strictEqual(sampling.mechanism, 3)
    sinon.assert.notCalled(setPriority)
  })

  it('preserves stronger propagated keep priorities', () => {
    extract.returns({ _traceId: 'parent' })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:2',
    })

    assert.strictEqual(sampling.priority, USER_KEEP)
    sinon.assert.notCalled(setPriority)
  })

  it('does not override sampling when the sampled flag is still set', () => {
    extract.returns({ _traceId: 'parent' })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'dd=s:1',
    })

    assert.strictEqual(sampling.priority, 0)
    sinon.assert.notCalled(setPriority)
  })

  it('does not override sampling when propagated priority is a drop', () => {
    extract.returns({ _traceId: 'parent' })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:-1',
    })

    assert.strictEqual(sampling.priority, 0)
    sinon.assert.notCalled(setPriority)
  })

  it('does not override sampling when tracestate has no datadog decision', () => {
    extract.returns({ _traceId: 'parent' })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'other=vendor',
    })

    assert.strictEqual(sampling.priority, 0)
    sinon.assert.notCalled(setPriority)
  })

  it('does not restore sampling when propagation behavior is restart', () => {
    plugin._tracer._config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = 'restart'
    extract.returns({ _traceId: 'parent' })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:1',
    })

    assert.strictEqual(sampling.priority, 0)
    sinon.assert.notCalled(setPriority)
  })

  it('does not restore sampling when propagation behavior is ignore', () => {
    plugin._tracer._config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = 'ignore'
    extract.returns({ _traceId: 'parent' })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:1',
    })

    assert.strictEqual(sampling.priority, 0)
    sinon.assert.notCalled(setPriority)
  })

  it('binds the started span on the invocation context', () => {
    const ctx = bindStart()

    assert.strictEqual(ctx.span, span)
  })
})
