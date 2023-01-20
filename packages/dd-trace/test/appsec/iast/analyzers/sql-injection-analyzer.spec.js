'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')

describe('sql-injection-analyzer', () => {
  const NOT_TAINTED_QUERY = 'no vulnerable query'
  const TAINTED_QUERY = 'vulnerable query'

  const TaintTrackingMock = {
    isTainted: (iastContext, string) => {
      return string === TAINTED_QUERY
    }
  }

  const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
    '../taint-tracking/operations': TaintTrackingMock
  })
  const sqlInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/sql-injection-analyzer', {
    './injection-analyzer': InjectionAnalyzer
  })

  sqlInjectionAnalyzer.configure(true)

  it('should subscribe to mysql, mysql2 and pg start query channel', () => {
    expect(sqlInjectionAnalyzer._subscriptions).to.have.lengthOf(3)
    expect(sqlInjectionAnalyzer._subscriptions[0]._channel.name).to.equals('apm:mysql:query:start')
    expect(sqlInjectionAnalyzer._subscriptions[1]._channel.name).to.equals('apm:mysql2:query:start')
    expect(sqlInjectionAnalyzer._subscriptions[2]._channel.name).to.equals('apm:pg:query:start')
  })

  it('should not detect vulnerability when no query', () => {
    const isVulnerable = sqlInjectionAnalyzer._isVulnerable()
    expect(isVulnerable).to.be.false
  })

  it('should not detect vulnerability when no vulnerable query', () => {
    const isVulnerable = sqlInjectionAnalyzer._isVulnerable(NOT_TAINTED_QUERY)
    expect(isVulnerable).to.be.false
  })

  it('should detect vulnerability when vulnerable query', () => {
    const isVulnerable = sqlInjectionAnalyzer._isVulnerable(TAINTED_QUERY)
    expect(isVulnerable).to.be.true
  })

  it('should report "SQL_INJECTION" vulnerability', () => {
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
    const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
      '../taint-tracking/operations': TaintTrackingMock,
      './vulnerability-analyzer': ProxyAnalyzer
    })
    const proxiedSqlInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/sql-injection-analyzer',
      {
        './injection-analyzer': InjectionAnalyzer
      })
    proxiedSqlInjectionAnalyzer.analyze(TAINTED_QUERY)
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch({}, { type: 'SQL_INJECTION' })
  })

  describe('analyze', () => {
    let sqlInjectionAnalyzer, analyze

    const store = {}
    const iastContext = {}

    beforeEach(() => {
      const getStore = sinon.stub().returns(store)
      const getIastContext = sinon.stub().returns(iastContext)

      const iastPlugin = proxyquire('../../../../src/appsec/iast/iast-plugin', {
        '../../../../datadog-core': { storage: { getStore } },
        './iast-context': { getIastContext }
      })

      const ProxyAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/vulnerability-analyzer', {
        '../iast-plugin': iastPlugin,
        '../overhead-controller': { hasQuota: () => true }
      })
      const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
        '../taint-tracking/operations': TaintTrackingMock,
        './vulnerability-analyzer': ProxyAnalyzer
      })

      sqlInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/sql-injection-analyzer', {
        './injection-analyzer': InjectionAnalyzer
      })
      analyze = sinon.stub(sqlInjectionAnalyzer, 'analyze')
      sqlInjectionAnalyzer.configure(true)
    })

    afterEach(sinon.restore)

    it('should call analyze on apm:mysql:query:start', () => {
      const onMysqlQueryStart = sqlInjectionAnalyzer._subscriptions[0]._handler

      onMysqlQueryStart({ sql: 'SELECT 1', name: 'apm:mysql:query:start' })

      expect(analyze).to.be.calledOnceWith('SELECT 1')
    })

    it('should call analyze on apm:mysql2:query:start', () => {
      const onMysql2QueryStart = sqlInjectionAnalyzer._subscriptions[0]._handler

      onMysql2QueryStart({ sql: 'SELECT 1', name: 'apm:mysql2:query:start' })

      expect(analyze).to.be.calledOnceWith('SELECT 1')
    })

    it('should call analyze on apm:pg:query:start', () => {
      const onPgQueryStart = sqlInjectionAnalyzer._subscriptions[0]._handler

      onPgQueryStart({ sql: 'SELECT 1', name: 'apm:pg:query:start' })

      expect(analyze).to.be.calledOnceWith('SELECT 1')
    })
  })
})
