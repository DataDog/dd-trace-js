'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { INSTRUMENTED_PROPAGATION } = require('../../../../src/appsec/iast/telemetry/iast-metric')
const { Verbosity } = require('../../../../src/appsec/iast/telemetry/verbosity')

describe('rewriter telemetry', () => {
  let iastTelemetry, incrementTelemetryIfNeeded
  let instrumentedPropagationInc

  beforeEach(() => {
    iastTelemetry = {
      add: sinon.spy()
    }
    const rewriterTelemetry = proxyquire('../../../../src/appsec/iast/taint-tracking/rewriter-telemetry', {
      '../telemetry': iastTelemetry
    })
    incrementTelemetryIfNeeded = rewriterTelemetry.incrementTelemetryIfNeeded
    instrumentedPropagationInc = sinon.stub(INSTRUMENTED_PROPAGATION, 'inc')
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('incrementTelemetryIfNeeded', () => {
    it('should not increment telemetry when verbosity is OFF', () => {
      iastTelemetry.verbosity = Verbosity.OFF
      const metrics = {
        instrumentedPropagation: 2
      }
      incrementTelemetryIfNeeded(metrics)

      expect(instrumentedPropagationInc).not.to.be.called
    })

    it('should increment telemetry when verbosity is not OFF', () => {
      iastTelemetry.verbosity = Verbosity.DEBUG
      const metrics = {
        instrumentedPropagation: 2
      }
      incrementTelemetryIfNeeded(metrics)

      expect(instrumentedPropagationInc).to.be.calledOnceWith(undefined, metrics.instrumentedPropagation)
    })
  })
})
