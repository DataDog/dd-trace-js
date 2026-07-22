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

  it('re-applies propagated keep when the host cleared the sampled flag', () => {
    const parent = { _traceId: 'parent' }
    extract.returns(parent)

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:1',
    })

    sinon.assert.calledOnceWithExactly(setPriority, span, AUTO_KEEP)
  })

  it('preserves stronger propagated keep priorities', () => {
    const parent = { _traceId: 'parent' }
    extract.returns(parent)

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:2',
    })

    sinon.assert.calledOnceWithExactly(setPriority, span, USER_KEEP)
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
