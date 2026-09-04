'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../dd-trace/test/setup/core')

const { AUTO_KEEP, USER_KEEP } = require('../../../ext/priority')
const { SAMPLING_MECHANISM_AGENT, SAMPLING_MECHANISM_RULE } = require('../../dd-trace/src/constants')
const AzureDurableFunctionsPlugin = require('../src')

describe('azure-durable-functions plugin', () => {
  let plugin
  let extract
  let startSpan
  let setPriority
  let span

  beforeEach(() => {
    setPriority = sinon.stub()
    span = {
      _prioritySampler: { setPriority },
      setTag: sinon.stub(),
    }

    extract = sinon.stub()
    startSpan = sinon.stub().returns(span)

    plugin = new AzureDurableFunctionsPlugin({
      extract,
      startSpan,
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

    sinon.assert.calledOnceWithExactly(extract, 'text_map', {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'dd=s:1',
    })
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

  it('names orchestration spans from the Orchestration trigger', () => {
    bindStart({
      trigger: 'Orchestration',
      functionName: 'PizzaOrderOrchestration',
    })

    sinon.assert.calledWith(
      startSpan,
      'azure.functions.invoke',
      sinon.match({
        tags: sinon.match({
          'aas.function.name': 'PizzaOrderOrchestration',
          'aas.function.trigger': 'Orchestration',
          'resource.name': 'Orchestration PizzaOrderOrchestration',
          'span.kind': 'server',
        }),
      })
    )
  })

  for (const trigger of ['Activity', 'Entity']) {
    it(`uses internal span kind for ${trigger} invocations`, () => {
      bindStart({ trigger })

      sinon.assert.calledWith(
        startSpan,
        'azure.functions.invoke',
        sinon.match({
          tags: sinon.match({ 'span.kind': 'internal' }),
        })
      )
    })
  }

  it('uses the provided invocation start time', () => {
    bindStart({ startTime: 123 })

    sinon.assert.calledWith(
      startSpan,
      'azure.functions.invoke',
      sinon.match({ startTime: 123 })
    )
  })

  it('continues the host trace for orchestration invocations', () => {
    const parent = { _traceId: 'parent' }
    extract.returns(parent)

    bindStart({
      trigger: 'Orchestration',
      functionName: 'PizzaOrderOrchestration',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'dd=s:1',
    })

    sinon.assert.calledWith(
      startSpan,
      'azure.functions.invoke',
      sinon.match({ childOf: parent })
    )
  })

  it('re-applies propagated keep without replacing the sampling mechanism', () => {
    const parentId = {}
    const parent = { _traceId: 'parent', _spanId: parentId }
    const sampling = { priority: 0, mechanism: SAMPLING_MECHANISM_AGENT }
    extract.returns(parent)
    span.context = sinon.stub().returns({ _parentId: parentId, _sampling: sampling })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:1',
    })

    assert.strictEqual(sampling.priority, AUTO_KEEP)
    assert.strictEqual(sampling.mechanism, SAMPLING_MECHANISM_AGENT)
    sinon.assert.notCalled(setPriority)
  })

  it('preserves stronger propagated keep priorities', () => {
    const parentId = {}
    const parent = { _traceId: 'parent', _spanId: parentId }
    const sampling = { priority: 0, mechanism: SAMPLING_MECHANISM_RULE }
    extract.returns(parent)
    span.context = sinon.stub().returns({ _parentId: parentId, _sampling: sampling })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:2',
    })

    assert.strictEqual(sampling.priority, USER_KEEP)
    assert.strictEqual(sampling.mechanism, SAMPLING_MECHANISM_RULE)
    sinon.assert.notCalled(setPriority)
  })

  it('does not re-apply propagated keep when the extracted context is not continued', () => {
    const parent = { _traceId: 'parent', _spanId: {} }
    extract.returns(parent)
    span.context = sinon.stub().returns({ _parentId: null })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:1',
    })

    sinon.assert.notCalled(setPriority)
  })

  it('does not re-apply propagated keep to a noop span', () => {
    const parentId = {}
    const parent = { _traceId: 'parent', _spanId: parentId }
    const sampling = { priority: -1 }
    extract.returns(parent)
    span._prioritySampler = undefined
    span.context = sinon.stub().returns({ _parentId: parentId, _sampling: sampling })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:1',
    })

    assert.strictEqual(sampling.priority, -1)
  })

  it('does not override sampling when the sampled flag is still set', () => {
    const parent = { _traceId: 'parent' }
    extract.returns(parent)

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'dd=s:1',
    })

    sinon.assert.notCalled(setPriority)
  })

  it('does not override sampling when propagated priority is a drop', () => {
    const parent = { _traceId: 'parent' }
    extract.returns(parent)

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:-1',
    })

    sinon.assert.notCalled(setPriority)
  })

  it('does not override sampling when tracestate has no datadog decision', () => {
    const parent = { _traceId: 'parent' }
    extract.returns(parent)

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'other=vendor',
    })

    sinon.assert.notCalled(setPriority)
  })

  it('binds the started span on the invocation context', () => {
    const ctx = bindStart()

    assert.strictEqual(ctx.span, span)
  })
})
