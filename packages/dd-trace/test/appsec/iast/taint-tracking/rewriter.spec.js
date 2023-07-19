'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')

describe('IAST Rewriter', () => {
  it('Addon should return a rewritter instance', () => {
    let rewriter = null
    expect(() => {
      rewriter = require('@datadog/native-iast-rewriter')
    }).to.not.throw(Error)
    expect(rewriter).to.not.be.null
  })

  describe('Enabling rewriter', () => {
    let rewriter, iastTelemetry

    const shimmer = {
      wrap: sinon.spy(),
      unwrap: sinon.spy()
    }

    class Rewriter {
      rewrite (content, filename) {
        return {
          content: content + 'rewritten',
          metrics: {
            instrumentedPropagation: 2
          }
        }
      }
    }

    beforeEach(() => {
      iastTelemetry = {
        add: sinon.spy()
      }
      rewriter = proxyquire('../../../../src/appsec/iast/taint-tracking/rewriter', {
        '@datadog/native-iast-rewriter': { Rewriter, getPrepareStackTrace: function () {} },
        '../../../../../datadog-shimmer': shimmer,
        '../../telemetry': iastTelemetry
      })
    })

    afterEach(() => {
      sinon.restore()
    })

    it('Should wrap module compile method on taint tracking enable', () => {
      rewriter.enableRewriter()
      expect(shimmer.wrap).to.be.calledOnce
      expect(shimmer.wrap.getCall(0).args[1]).eq('_compile')
    })

    it('Should unwrap module compile method on taint tracking disable', () => {
      rewriter.disableRewriter()
      expect(shimmer.unwrap).to.be.calledOnce
      expect(shimmer.unwrap.getCall(0).args[1]).eq('_compile')
    })
  })
})
