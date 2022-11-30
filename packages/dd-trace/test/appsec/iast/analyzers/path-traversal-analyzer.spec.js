'use strict'

const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const expect = require('chai').expect
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const pathTraversalAnalyzer = require('../../../../src/appsec/iast/analyzers/path-traversal-analyzer')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const { testThatRequestHasVulnerability } = require('../utils')
const { clearCache } = require('../../../../src/appsec/iast/vulnerability-reporter')

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

const TaintTrackingMock = {
  isTainted: sinon.stub()
}

const getIastContext = sinon.stub()
const hasQuota = sinon.stub()
const addVulnerability = sinon.stub()

const ProxyAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/vulnerability-analyzer', {
  '../iast-context': { getIastContext },
  '../overhead-controller': { hasQuota },
  '../vulnerability-reporter': { addVulnerability }
})

const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
  './vulnerability-analyzer': ProxyAnalyzer,
  '../taint-tracking/operations': TaintTrackingMock
})

describe('path-traversal-analyzer', () => {
  it('Analyzer should be subscribed to proper channel', () => {
    expect(pathTraversalAnalyzer._subscriptions).to.have.lengthOf(1)
    expect(pathTraversalAnalyzer._subscriptions[0]._channel.name).to.equals('datadog:fs:access')
  })

  it('If no context it should not report vulnerability', () => {
    const iastContext = null
    const isVulnerable = pathTraversalAnalyzer._isVulnerable('test', iastContext)
    expect(isVulnerable).to.be.false
  })

  it('If no context it should return evidence with an undefined ranges array', () => {
    const evidence = pathTraversalAnalyzer._getEvidence('', null)
    expect(evidence.value).to.be.equal('')
    expect(evidence.ranges).to.be.instanceof(Array)
    expect(evidence.ranges).to.have.length(0)
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
    // const isTainted = sinon.stub()
    const iastContext = {}
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer', {
      './injection-analyzer': InjectionAnalyzer
    })
    TaintTrackingMock.isTainted.returns(false)
    const result = proxyPathAnalyzer._isVulnerable('test', iastContext)
    expect(result).to.be.false
    expect(TaintTrackingMock.isTainted).to.have.been.calledOnce
  })

  it('Should report proper vulnerability type', () => {
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer', {
      './injection-analyzer': InjectionAnalyzer,
      '../iast-context': { getIastContext: () => iastContext }
    })

    getIastContext.returns(iastContext)
    hasQuota.returns(true)
    TaintTrackingMock.isTainted.returns(true)

    proxyPathAnalyzer.analyze(['test'])
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch(iastContext, { type: 'PATH_TRAVERSAL' })
  })

  it('Should report 1st argument', () => {
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer',
      { './injection-analyzer': InjectionAnalyzer,
        '../iast-context': { getIastContext: () => iastContext }
      })

    addVulnerability.reset()
    getIastContext.returns(iastContext)
    TaintTrackingMock.isTainted.returns(true)
    hasQuota.returns(true)

    proxyPathAnalyzer.analyze(['taintedArg1', 'taintedArg2'])
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch(iastContext, { evidence: { value: 'taintedArg1' } })
  })

  it('Should report 2nd argument', () => {
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer', {
      './injection-analyzer': InjectionAnalyzer,
      '../iast-context': { getIastContext: () => iastContext }
    })

    addVulnerability.reset()
    TaintTrackingMock.isTainted.reset()
    getIastContext.returns(iastContext)
    TaintTrackingMock.isTainted.onFirstCall().returns(false)
    TaintTrackingMock.isTainted.onSecondCall().returns(true)
    hasQuota.returns(true)

    proxyPathAnalyzer.analyze(['arg1', 'taintedArg2'])
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch(iastContext, { evidence: { value: 'taintedArg2' } })
  })
})

describe('integration test', () => {
  beforeEach(() => {
    clearCache()
  })
  describe('not promise method', () => {
    testThatRequestHasVulnerability(function () {
      const store = storage.getStore()
      const iastCtx = iastContextFunctions.getIastContext(store)
      let path = __filename
      path = newTaintedString(iastCtx, __filename, 'param', 'Request')
      require('fs').openSync(path, 'r')
    }, 'PATH_TRAVERSAL')
  })

  describe('promised method', () => {
    testThatRequestHasVulnerability(async function () {
      const store = storage.getStore()
      const iastCtx = iastContextFunctions.getIastContext(store)
      let path = __filename
      path = newTaintedString(iastCtx, __filename, 'param', 'Request')
      await require('fs').promises.open(path, 'r')
    }, 'PATH_TRAVERSAL')
  })
})
