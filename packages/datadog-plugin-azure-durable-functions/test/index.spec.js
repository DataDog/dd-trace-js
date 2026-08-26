'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../dd-trace/test/setup/core')

const formats = require('../../../ext/formats')
const AzureDurableFunctionsPlugin = require('../src')

describe('azure-durable-functions plugin', () => {
  let plugin
  let extract
  let startSpan
  let applyTracestateKeepOverClearedFlag
  let span

  beforeEach(() => {
    applyTracestateKeepOverClearedFlag = sinon.stub()
    span = {
      setTag: sinon.stub(),
    }

    extract = sinon.stub()
    startSpan = sinon.stub().returns(span)

    plugin = new AzureDurableFunctionsPlugin({
      extract,
      startSpan,
      _propagators: {
        [formats.TEXT_MAP]: { applyTracestateKeepOverClearedFlag },
      },
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

  it('restores tracestate keep through the text_map propagator', () => {
    const parent = { _traceId: 'parent' }
    extract.returns(parent)

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:1',
    })

    sinon.assert.calledOnceWithExactly(
      applyTracestateKeepOverClearedFlag,
      parent,
      'dd=s:1'
    )
  })

  it('does not restore sampling when propagation behavior is restart', () => {
    plugin._tracer._config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = 'restart'
    extract.returns({ _traceId: 'parent' })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:1',
    })

    sinon.assert.notCalled(applyTracestateKeepOverClearedFlag)
  })

  it('does not restore sampling when propagation behavior is ignore', () => {
    plugin._tracer._config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = 'ignore'
    extract.returns({ _traceId: 'parent' })

    bindStart({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'dd=s:1',
    })

    sinon.assert.notCalled(applyTracestateKeepOverClearedFlag)
  })

  it('normalizes a failed extract to undefined childOf', () => {
    extract.returns(null)

    bindStart({
      traceparent: 'not-a-valid-traceparent',
    })

    sinon.assert.notCalled(applyTracestateKeepOverClearedFlag)
    sinon.assert.calledWith(
      startSpan,
      'azure.functions.invoke',
      sinon.match({ childOf: undefined })
    )
  })

  it('does not extract when traceparent is missing', () => {
    bindStart()

    sinon.assert.notCalled(extract)
    sinon.assert.notCalled(applyTracestateKeepOverClearedFlag)
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

  it('binds the started span on the invocation context', () => {
    const ctx = bindStart()

    assert.strictEqual(ctx.span, span)
  })
})
