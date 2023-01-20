'use strict'
const { expect } = require('chai')
const proxyquire = require('proxyquire')

const { INSTRUMENTED_PROPAGATION, INSTRUMENTATION_TIME,
  PropagationType } = require('../../../../src/appsec/iast/iast-metric')
const { Verbosity } = require('../../../../src/appsec/telemetry/verbosity')

describe('rewriter telemetry', () => {
  let telemetry, rewriter, getRewriteFunction
  let instrumentedPropagationAdd
  let instrumentationTimeAdd

  beforeEach(() => {
    telemetry = {
      add: sinon.spy()
    }
    const rewriterTelemetry = proxyquire('../../../../src/appsec/iast/taint-tracking/rewriter-telemetry', {
      '../../telemetry': telemetry
    })
    getRewriteFunction = rewriterTelemetry.getRewriteFunction
    rewriter = {
      rewrite: (content) => {
        return {
          content: content + 'rewritten',
          metrics: {
            instrumentedPropagation: 2
          }
        }
      }
    }
    instrumentedPropagationAdd = sinon.stub(INSTRUMENTED_PROPAGATION, 'add')
    instrumentationTimeAdd = sinon.stub(INSTRUMENTATION_TIME, 'add')
  })

  afterEach(sinon.restore)

  it('should not increase any metrics with OFF verbosity', () => {
    telemetry.verbosity = Verbosity.OFF

    const rewriteFn = getRewriteFunction(rewriter)
    rewriteFn('const a = b + c', 'test.js')

    expect(instrumentedPropagationAdd).to.not.be.called
  })

  it('should increase information metrics with MANDATORY verbosity', () => {
    telemetry.verbosity = Verbosity.MANDATORY

    const rewriteFn = getRewriteFunction(rewriter)
    const result = rewriteFn('const a = b + c', 'test.js')

    expect(instrumentedPropagationAdd).to.be.calledOnceWith(result.metrics.instrumentedPropagation,
      PropagationType.STRING)
  })

  it('should increase information metrics with INFORMATION verbosity', () => {
    telemetry.verbosity = Verbosity.INFORMATION

    const rewriteFn = getRewriteFunction(rewriter)
    const result = rewriteFn('const a = b + c', 'test.js')

    expect(instrumentedPropagationAdd).to.be.calledOnceWith(result.metrics.instrumentedPropagation,
      PropagationType.STRING)
  })

  it('should increase debug metrics with DEBUG verbosity', () => {
    telemetry.verbosity = Verbosity.DEBUG

    const rewriteFn = getRewriteFunction(rewriter)
    const result = rewriteFn('const a = b + c', 'test.js')

    expect(instrumentedPropagationAdd).to.be.calledOnceWith(result.metrics.instrumentedPropagation,
      PropagationType.STRING)

    expect(instrumentationTimeAdd).to.be.calledOnce
  })
})
