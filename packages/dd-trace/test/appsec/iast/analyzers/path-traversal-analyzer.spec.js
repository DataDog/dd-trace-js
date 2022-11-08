'use strict'

const expect = require('chai').expect
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const pathTraversalAnalyzer = require('../../../../src/appsec/iast/analyzers/path-traversal-analyzer')

describe('path-traversal-analyzer', () => {
  it('Analyzer should be subscribe to proper channel', () => {
    expect(pathTraversalAnalyzer._subscriptions).to.have.lengthOf(1)
    expect(pathTraversalAnalyzer._subscriptions[0]._channel.name).to.equals('datadog:path:access')
  })

  it('If no context it should not report vulnerability', () => {
    const iastContext = null
    const isVulnerable = pathTraversalAnalyzer._isVulnerable('test', iastContext)
    expect(isVulnerable).to.be.false
  })

  it('If no context it should return evidence with an undefined ranges array', () => {
    const evidence = pathTraversalAnalyzer._getEvidence('test', null)
    expect(evidence.value).to.be.equal('test')
    expect(evidence.ranges).to.be.equal(undefined)
  })

  it('if context exists but value is not a string it should not call isTainted', () => {
    const isTainted = sinon.stub()
    const iastContext = {}
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer', {
      '../taint-tracking': { isTainted }
    })

    proxyPathAnalyzer._isVulnerable(undefined, iastContext)
    expect(isTainted).to.have.been.callCount(0)
  })

  it('if context and value are valid it should call isTainted', () => {
    const isTainted = sinon.stub()
    isTainted.returns(false)
    const iastContext = {}
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer', {
      '../taint-tracking/operations': { isTainted }
    })

    const result = proxyPathAnalyzer._isVulnerable('test', iastContext)
    expect(result).to.be.false
    expect(isTainted).to.have.been.calledOnce
  })

  it('Should report proper vulnerability type', () => {
    const addVulnerability = sinon.stub()
    const iastContext = {
      rootSpan: {
        context () {
          return {
            toSpanId () {
              return '123'
            }
          }
        }
      }
    }
    const ProxyAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/vulnerability-analyzer', {
      '../iast-context': {
        getIastContext: () => iastContext
      },
      '../overhead-controller': { hasQuota: () => true },
      '../vulnerability-reporter': { addVulnerability }
    })
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer',
      { './vulnerability-analyzer': ProxyAnalyzer,
        '../taint-tracking/operations': { isTainted: () => true }
      })

    proxyPathAnalyzer.analyze('test')
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch(iastContext, { type: 'PATH_TRAVERSAL' })
  })
})
