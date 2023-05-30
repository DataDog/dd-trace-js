'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const overheadController = require('../../../../src/appsec/iast/overhead-controller')

describe('unvalidated-redirect-analyzer', () => {
  const NOT_TAINTED_LOCATION = 'url.com'
  const TAINTED_LOCATION = 'evil.com'

  const TaintTrackingMock = {
    isTainted: (iastContext, string) => {
      return string === TAINTED_LOCATION
    }
  }

  let report
  beforeEach(() => {
    report = sinon.stub(unvalidatedRedirectAnalyzer, '_report')
  })

  afterEach(sinon.restore)

  const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
    '../taint-tracking/operations': TaintTrackingMock
  })
  const unvalidatedRedirectAnalyzer =
    proxyquire('../../../../src/appsec/iast/analyzers/unvalidated-redirect-analyzer', {
      './injection-analyzer': InjectionAnalyzer
    })

  it('should subscribe to set-header:finish channel', () => {
    expect(unvalidatedRedirectAnalyzer._subscriptions).to.have.lengthOf(1)
    expect(unvalidatedRedirectAnalyzer._subscriptions[0]._channel.name).to
      .equals('datadog:http:server:response:set-header:finish')
  })

  it('should not report headers other than Location', () => {
    unvalidatedRedirectAnalyzer.analyze('X-test', NOT_TAINTED_LOCATION)

    expect(report).to.not.have.been.called
  })

  it('should not report Location header with non string values', () => {
    unvalidatedRedirectAnalyzer.analyze('X-test', [TAINTED_LOCATION])

    expect(report).to.not.have.been.called
  })

  it('should not report Location header with not tainted string value', () => {
    unvalidatedRedirectAnalyzer.analyze('Location', NOT_TAINTED_LOCATION)

    expect(report).to.not.have.been.called
  })

  it('should report Location header with tainted string value', () => {
    sinon.stub(overheadController, 'hasQuota').returns(1)

    unvalidatedRedirectAnalyzer.analyze('Location', TAINTED_LOCATION)

    expect(report).to.be.called
  })
})
