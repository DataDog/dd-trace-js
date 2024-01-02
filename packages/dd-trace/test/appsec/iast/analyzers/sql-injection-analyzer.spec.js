'use strict'

const proxyquire = require('proxyquire')

const iastLog = require('../../../../src/appsec/iast/iast-log')
const dc = require('dc-polyfill')

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

  afterEach(() => {
    sinon.restore()
  })

  sqlInjectionAnalyzer.configure(true)

  it('should subscribe to mysql, mysql2 and pg start query channel', () => {
    expect(sqlInjectionAnalyzer._subscriptions).to.have.lengthOf(11)
    expect(sqlInjectionAnalyzer._subscriptions[0]._channel.name).to.equals('apm:mysql:query:start')
    expect(sqlInjectionAnalyzer._subscriptions[1]._channel.name).to.equals('apm:mysql2:query:start')
    expect(sqlInjectionAnalyzer._subscriptions[2]._channel.name).to.equals('apm:pg:query:start')
    expect(sqlInjectionAnalyzer._subscriptions[3]._channel.name).to.equals('datadog:sequelize:query:start')
    expect(sqlInjectionAnalyzer._subscriptions[4]._channel.name).to.equals('datadog:sequelize:query:finish')
    expect(sqlInjectionAnalyzer._subscriptions[5]._channel.name).to.equals('datadog:pg:pool:query:start')
    expect(sqlInjectionAnalyzer._subscriptions[6]._channel.name).to.equals('datadog:pg:pool:query:finish')
    expect(sqlInjectionAnalyzer._subscriptions[7]._channel.name).to.equals('datadog:mysql:pool:query:start')
    expect(sqlInjectionAnalyzer._subscriptions[8]._channel.name).to.equals('datadog:mysql:pool:query:finish')
    expect(sqlInjectionAnalyzer._subscriptions[9]._channel.name).to.equals('datadog:knex:raw:start')
    expect(sqlInjectionAnalyzer._subscriptions[10]._channel.name).to.equals('datadog:knex:raw:finish')
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
    const dialect = 'DIALECT'
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
      '../overhead-controller': { hasQuota: () => true }
    })
    const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
      '../taint-tracking/operations': TaintTrackingMock,
      './vulnerability-analyzer': ProxyAnalyzer
    })
    const proxiedSqlInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/sql-injection-analyzer',
      {
        './injection-analyzer': InjectionAnalyzer,
        '../taint-tracking/operations': TaintTrackingMock,
        '../iast-context': {
          getIastContext: () => iastContext
        },
        '../vulnerability-reporter': { addVulnerability }
      })
    proxiedSqlInjectionAnalyzer.analyze(TAINTED_QUERY, dialect)
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch({}, {
      type: 'SQL_INJECTION',
      evidence: { dialect: dialect }
    })
  })

  it('should not report an error when context is not initialized', () => {
    sinon.stub(iastLog, 'errorAndPublish')
    sqlInjectionAnalyzer.configure(true)
    dc.channel('datadog:sequelize:query:finish').publish()
    sqlInjectionAnalyzer.configure(false)
    expect(iastLog.errorAndPublish).not.to.be.called
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

  describe('knex dialects', () => {
    const sqlInjectionAnalyzer = require('../../../../src/appsec/iast/analyzers/sql-injection-analyzer')

    const knexDialects = {
      'mssql': 'MSSQL',
      'oracle': 'ORACLE',
      'mysql': 'MYSQL',
      'redshift': 'REDSHIFT',
      'postgresql': 'POSTGRES',
      'sqlite3': 'SQLITE'
    }

    Object.keys(knexDialects).forEach((knexDialect) => {
      it(`should normalize knex dialect ${knexDialect} to uppercase`, () => {
        const normalizedDialect = sqlInjectionAnalyzer.normalizeKnexDialect(knexDialect)
        expect(normalizedDialect).to.equals(knexDialects[knexDialect])
      })
    })

    it('should not fail when normalizing a non string knex dialect', () => {
      const normalizedDialect = sqlInjectionAnalyzer.normalizeKnexDialect()
      expect(normalizedDialect).to.be.undefined
    })
  })
})
