'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { HTTP_REQUEST_PARAMETER } = require('../../../../src/appsec/iast/taint-tracking/source-types')
const log = require('../../../../src/log')
const { SQL_INJECTION_MARK, COMMAND_INJECTION_MARK } =
  require('../../../../src/appsec/iast/taint-tracking/secure-marks')

describe('sql-injection-analyzer', () => {
  const NOT_TAINTED_QUERY = 'no vulnerable query'
  const TAINTED_QUERY = 'vulnerable query'
  const TAINTED_SQLI_SECURED = 'sqli secure marked vulnerable query'
  const TAINTED_CMDI_SECURED = 'cmdi secure marked vulnerable query'

  function getRanges (string, secureMarks) {
    const range = {
      start: 0,
      end: string.length,
      iinfo: {
        parameterName: 'param',
        parameterValue: string,
        type: HTTP_REQUEST_PARAMETER,
      },
      secureMarks,
    }

    return [range]
  }

  const TaintTrackingMock = {
    getRanges: (iastContext, string) => {
      switch (string) {
        case TAINTED_QUERY:
          return getRanges(string)

        case TAINTED_SQLI_SECURED:
          return getRanges(string, SQL_INJECTION_MARK)

        case TAINTED_CMDI_SECURED:
          return getRanges(string, COMMAND_INJECTION_MARK)

        default:
          return []
      }
    },
  }

  const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
    '../taint-tracking/operations': TaintTrackingMock,
  })
  const StoredInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/stored-injection-analyzer', {
    './injection-analyzer': InjectionAnalyzer,
  })
  const sourceRegistry = {
    registerContributor: sinon.stub(),
    unregisterContributor: sinon.stub(),
  }
  const sqlInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/sql-injection-analyzer', {
    './stored-injection-analyzer': StoredInjectionAnalyzer,
    '../../../events/source-registry': { getEventSourceRegistry: () => sourceRegistry },
  })

  function getSubscriptionHandler (analyzer, channelName) {
    const subscription = analyzer._subscriptions.find(({ _channel }) => _channel.name === channelName)

    assert.ok(subscription, `Missing subscription for ${channelName}`)

    return subscription._handler
  }

  afterEach(() => {
    sinon.restore()
  })

  sqlInjectionAnalyzer.configure(true)

  it('should use one database contributor for mysql package events', () => {
    assert.deepStrictEqual(sqlInjectionAnalyzer._subscriptions.map(({ _channel }) => _channel.name), [
      'datadog:mysql2:outerquery:start',
      'apm:pg:query:start',
      'datadog:sequelize:query:finish',
      'datadog:pg:pool:query:finish',
    ])

    assert.deepStrictEqual(sqlInjectionAnalyzer._bindings.map(({ _channel }) => _channel.name), [
      'datadog:sequelize:query:start',
      'datadog:pg:pool:query:start',
      'datadog:knex:raw:start',
      'datadog:knex:raw:subscribes',
      'datadog:knex:raw:finish',
    ])

    sinon.assert.calledOnceWithMatch(
      sourceRegistry.registerContributor,
      'db.query',
      'iast.sql-injection',
      { start: sinon.match.func, finish: sinon.match.func }
    )
  })

  it('should not detect vulnerability when no query', () => {
    const isVulnerable = sqlInjectionAnalyzer._isVulnerable()
    assert.strictEqual(isVulnerable, false)
  })

  it('should not detect vulnerability when no vulnerable query', () => {
    const isVulnerable = sqlInjectionAnalyzer._isVulnerable(NOT_TAINTED_QUERY)
    assert.strictEqual(isVulnerable, false)
  })

  it('should detect vulnerability when vulnerable query', () => {
    const isVulnerable = sqlInjectionAnalyzer._isVulnerable(TAINTED_QUERY)
    assert.strictEqual(isVulnerable, true)
  })

  it('should not detect vulnerability when vulnerable query with sqli secure mark', () => {
    const isVulnerable = sqlInjectionAnalyzer._isVulnerable(TAINTED_SQLI_SECURED)
    assert.strictEqual(isVulnerable, false)
  })

  it('should detect vulnerability when vulnerable query with cmdi secure mark', () => {
    const isVulnerable = sqlInjectionAnalyzer._isVulnerable(TAINTED_CMDI_SECURED)
    assert.strictEqual(isVulnerable, true)
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
            },
          }
        },
      },
    }
    const ProxyAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/vulnerability-analyzer', {
      '../iast-context': {
        getIastContext: () => iastContext,
      },
      '../overhead-controller': { hasQuota: () => true },
    })
    sinon.stub(ProxyAnalyzer.prototype, '_reportEvidence')
    const reportEvidence = ProxyAnalyzer.prototype._reportEvidence

    const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
      '../taint-tracking/operations': TaintTrackingMock,
      './vulnerability-analyzer': ProxyAnalyzer,
    })

    const StoredInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/stored-injection-analyzer', {
      './injection-analyzer': InjectionAnalyzer,
    })

    const proxiedSqlInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/sql-injection-analyzer',
      {
        './stored-injection-analyzer': StoredInjectionAnalyzer,
        '../taint-tracking/operations': TaintTrackingMock,
        '../iast-context': {
          getIastContext: () => iastContext,
        },
        '../vulnerability-reporter': { addVulnerability },
      })
    proxiedSqlInjectionAnalyzer.analyze(TAINTED_QUERY, undefined, dialect)
    sinon.assert.calledOnce(reportEvidence)
    sinon.assert.calledWithMatch(reportEvidence, TAINTED_QUERY, {}, {
      value: TAINTED_QUERY,
      dialect,
    })
  })

  it('should not report an error when context is not initialized', () => {
    sinon.stub(log, 'error')
    sqlInjectionAnalyzer.configure(true)
    dc.channel('datadog:sequelize:query:finish').publish()
    sqlInjectionAnalyzer.configure(false)
    sinon.assert.notCalled(log.error)
  })

  describe('analyze', () => {
    let sqlInjectionAnalyzer, analyze
    let getStore

    const store = {}
    const iastContext = {}

    beforeEach(() => {
      getStore = sinon.stub().returns(store)
      const getIastContext = sinon.stub().returns(iastContext)
      const sourceRegistry = {
        registerContributor: sinon.stub(),
        unregisterContributor: sinon.stub(),
      }

      const datadogCore = {
        storage: () => {
          return {
            enterWith: sinon.stub(),
            getHandle: sinon.stub(),
            getStore,
          }
        },
      }

      const iastPlugin = proxyquire('../../../../src/appsec/iast/iast-plugin', {
        '../../../../datadog-core': datadogCore,
        './iast-context': { getIastContext },
      })

      const ProxyAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/vulnerability-analyzer', {
        '../iast-plugin': iastPlugin,
        '../overhead-controller': { hasQuota: () => true },
      })
      const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
        '../taint-tracking/operations': TaintTrackingMock,
        './vulnerability-analyzer': ProxyAnalyzer,
      })

      const StoredInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/stored-injection-analyzer', {
        './injection-analyzer': InjectionAnalyzer,
      })

      sqlInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/sql-injection-analyzer', {
        './stored-injection-analyzer': StoredInjectionAnalyzer,
        '../../../../../datadog-core': datadogCore,
        '../../../events/source-registry': { getEventSourceRegistry: () => sourceRegistry },
      })
      analyze = sinon.stub(sqlInjectionAnalyzer, 'analyze')
      sqlInjectionAnalyzer.configure(true)
    })

    afterEach(sinon.restore)

    it('should analyze a normalized mysql connection query event', () => {
      const event = {
        source: { integration: 'mysql' },
        data: { scope: 'connection', statement: 'SELECT 1' },
      }

      assert.strictEqual(sqlInjectionAnalyzer.analyzeDatabaseQuery(event, store), store)
      sinon.assert.calledOnceWithExactly(analyze, 'SELECT 1', store, 'MYSQL')
    })

    it('should ignore normalized events from another database source', () => {
      const event = {
        source: { integration: 'mariadb' },
        data: { scope: 'connection', statement: 'SELECT 1' },
      }

      assert.strictEqual(sqlInjectionAnalyzer.analyzeDatabaseQuery(event, store), store)
      sinon.assert.notCalled(analyze)
    })

    it('should call analyze on apm:mysql2:query:start', () => {
      const onMysql2QueryStart = getSubscriptionHandler(sqlInjectionAnalyzer, 'datadog:mysql2:outerquery:start')

      onMysql2QueryStart({ sql: 'SELECT 1' })

      sinon.assert.calledOnceWithMatch(analyze, 'SELECT 1')
    })

    it('should call analyze on apm:pg:query:start', () => {
      const onPgQueryStart = getSubscriptionHandler(sqlInjectionAnalyzer, 'apm:pg:query:start')

      onPgQueryStart({ originalText: 'SELECT 1', query: { text: 'modified-query SELECT 1' } })

      sinon.assert.calledOnceWithMatch(analyze, 'SELECT 1')
    })

    it('should return an analyzed store for a normalized mysql pool query event', () => {
      const event = {
        source: { integration: 'mysql' },
        data: { scope: 'pool', statement: 'SELECT 1' },
      }

      const currentStore = sqlInjectionAnalyzer.analyzeDatabaseQuery(event, store)

      sinon.assert.calledOnceWithExactly(analyze, 'SELECT 1', store, 'MYSQL')
      assert.strictEqual(currentStore.sqlAnalyzed, true)
      assert.strictEqual(currentStore.sqlParentStore, store)
      assert.strictEqual(event.iastSqlAnalyzed, true)
    })

    it('should not analyze a nested mysql query twice', () => {
      const currentStore = { sqlAnalyzed: true }
      const event = {
        source: { integration: 'mysql' },
        data: { scope: 'connection', statement: 'SELECT 1' },
      }

      assert.strictEqual(sqlInjectionAnalyzer.analyzeDatabaseQuery(event, currentStore), currentStore)
      sinon.assert.notCalled(analyze)
    })

    it('should restore the parent store at normalized mysql pool completion', () => {
      const currentStore = { sqlAnalyzed: true, sqlParentStore: store }
      const event = {
        source: { integration: 'mysql' },
        iastSqlAnalyzed: true,
      }

      assert.strictEqual(sqlInjectionAnalyzer.finishDatabaseQuery(event, currentStore), store)
      assert.strictEqual(event.iastSqlAnalyzed, false)
    })

    it('should preserve stores for database events not analyzed by this contributor', () => {
      const event = {
        source: { integration: 'mysql' },
      }

      assert.strictEqual(sqlInjectionAnalyzer.finishDatabaseQuery(event, store), store)
    })
  })

  describe('knex dialects', () => {
    const sqlInjectionAnalyzer = require('../../../../src/appsec/iast/analyzers/sql-injection-analyzer')

    const knexDialects = {
      mssql: 'MSSQL',
      oracle: 'ORACLE',
      mysql: 'MYSQL',
      redshift: 'REDSHIFT',
      postgresql: 'POSTGRES',
      sqlite3: 'SQLITE',
    }

    Object.keys(knexDialects).forEach((knexDialect) => {
      it(`should normalize knex dialect ${knexDialect} to uppercase`, () => {
        const normalizedDialect = sqlInjectionAnalyzer.normalizeKnexDialect(knexDialect)
        assert.strictEqual(normalizedDialect, knexDialects[knexDialect])
      })
    })

    it('should not fail when normalizing a non string knex dialect', () => {
      const normalizedDialect = sqlInjectionAnalyzer.normalizeKnexDialect()
      assert.strictEqual(normalizedDialect, undefined)
    })
  })
})
