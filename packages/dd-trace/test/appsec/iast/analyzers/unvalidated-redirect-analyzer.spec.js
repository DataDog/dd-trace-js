'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const overheadController = require('../../../../src/appsec/iast/overhead-controller')
const { HTTP_REQUEST_HEADER_VALUE, HTTP_REQUEST_PARAMETER } =
  require('../../../../src/appsec/iast/taint-tracking/source-types')

describe('unvalidated-redirect-analyzer', () => {
  const NOT_TAINTED_LOCATION = 'url.com'
  const TAINTED_LOCATION = 'evil.com'

  const TAINTED_HEADER_REFERER_ONLY = 'TAINTED_HEADER_REFERER_ONLY'
  const TAINTED_HEADER_REFERER_AMONG_OTHERS = 'TAINTED_HEADER_REFERER_ONLY_AMONG_OTHERS'

  const REFERER_RANGE = {
    iinfo: {
      type: HTTP_REQUEST_HEADER_VALUE,
      parameterName: 'Referer'
    }
  }
  const PARAMETER1_RANGE = {
    iinfo: {
      type: HTTP_REQUEST_PARAMETER,
      parameterName: 'param1'
    }
  }
  const PARAMETER2_RANGE = {
    iinfo: {
      type: HTTP_REQUEST_PARAMETER,
      parameterName: 'param2'
    }
  }

  const TaintTrackingMock = {
    isTainted: (iastContext, string) => {
      return string === TAINTED_LOCATION
    },

    getRanges: (iastContext, value) => {
      if (value === NOT_TAINTED_LOCATION) return null

      if (value === TAINTED_HEADER_REFERER_ONLY) {
        return [REFERER_RANGE]
      } else if (value === TAINTED_HEADER_REFERER_AMONG_OTHERS) {
        return [REFERER_RANGE, PARAMETER1_RANGE]
      } else {
        return [PARAMETER1_RANGE, PARAMETER2_RANGE]
      }
    }
  }

  let report
  beforeEach(() => {
    sinon.stub(overheadController, 'hasQuota').returns(1)
    report = sinon.stub(unvalidatedRedirectAnalyzer, '_report')
  })

  afterEach(sinon.restore)

  const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
    '../taint-tracking/operations': TaintTrackingMock
  })
  const unvalidatedRedirectAnalyzer =
    proxyquire('../../../../src/appsec/iast/analyzers/unvalidated-redirect-analyzer', {
      './injection-analyzer': InjectionAnalyzer,
      '../taint-tracking/operations': TaintTrackingMock
    })

  unvalidatedRedirectAnalyzer.configure(true)

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
    unvalidatedRedirectAnalyzer.analyze('Location', TAINTED_LOCATION)

    expect(report).to.be.called
  })

  it('should not report if tainted origin is referer header exclusively', () => {
    unvalidatedRedirectAnalyzer.analyze('Location', TAINTED_HEADER_REFERER_ONLY)

    expect(report).to.not.be.called
  })

  it('should report if tainted origin contains referer header among others', () => {
    unvalidatedRedirectAnalyzer.analyze('Location', TAINTED_HEADER_REFERER_AMONG_OTHERS)

    expect(report).to.be.called
  })
})
