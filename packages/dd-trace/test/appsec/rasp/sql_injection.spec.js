'use strict'

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { storage } = require('../../../../datadog-core')
const { pgQueryStart, mysql2OuterQueryStart, wafRunFinished } = require('../../../src/appsec/channels')
const addresses = require('../../../src/appsec/addresses')
const { withRequest } = require('../../../src/appsec/store')

describe('RASP - sql_injection', () => {
  let waf, sqli

  const enterStore = (store) => {
    storage('legacy').enterWith(store)
  }

  beforeEach(() => {
    waf = {
      runSubContext: sinon.stub().returns({ duration: 1000 }),
    }

    sqli = proxyquire('../../../src/appsec/rasp/sql_injection', {
      '../waf': waf,
    })

    const config = {
      appsec: {
        DD_APPSEC_STACK_TRACE_ENABLED: true,
        DD_APPSEC_MAX_STACK_TRACES: 2,
        DD_APPSEC_MAX_STACK_TRACE_DEPTH: 42,
      },
    }

    sqli.enable(config)
  })

  afterEach(() => {
    sinon.restore()
    sqli.disable()
    enterStore({})
  })

  describe('analyzePgSqlInjection', () => {
    it('should analyze sql injection', () => {
      const ctx = {
        query: {
          text: 'SELECT 1',
        },
      }
      const req = {}
      enterStore(withRequest(undefined, req))

      pgQueryStart.publish(ctx)

      const subcontextData = {
        [addresses.DB_STATEMENT]: 'SELECT 1',
        [addresses.DB_SYSTEM]: 'postgresql',
      }
      sinon.assert.calledOnceWithExactly(waf.runSubContext, subcontextData, { type: 'sql_injection' })
    })

    it('should not analyze sql injection if rasp is disabled', () => {
      sqli.disable()

      const ctx = {
        query: {
          text: 'SELECT 1',
        },
      }
      const req = {}
      enterStore(withRequest(undefined, req))

      pgQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.runSubContext)
    })

    it('should not analyze sql injection if no store', () => {
      const ctx = {
        query: {
          text: 'SELECT 1',
        },
      }
      enterStore(undefined)

      pgQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.runSubContext)
    })

    it('should not analyze sql injection if no req', () => {
      const ctx = {
        query: {
          text: 'SELECT 1',
        },
      }
      enterStore({})

      pgQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.runSubContext)
    })

    it('should not analyze sql injection if no query', () => {
      const ctx = {
        query: {},
      }
      enterStore({})

      pgQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.runSubContext)
    })
  })

  describe('query caching', () => {
    const query = { query: { text: 'SELECT 1' } }

    for (const [description, result] of [
      ['missing context', undefined],
      ['timeout', { timeout: true }],
      ['native error', { errorCode: -2 }],
      ['blocking action', { actions: { block_request: { status_code: 403 } } }],
    ]) {
      it(`does not reevaluate the query after a ${description}`, () => {
        enterStore(withRequest(undefined, {}))
        waf.runSubContext.onFirstCall().returns(result)
        pgQueryStart.publish(query)
        pgQueryStart.publish(query)
        pgQueryStart.publish(query)

        sinon.assert.calledOnce(waf.runSubContext)
      })
    }

    it('deduplicates the same query text across database systems', () => {
      enterStore(withRequest(undefined, {}))
      pgQueryStart.publish(query)
      mysql2OuterQueryStart.publish({ sql: 'SELECT 1' })
      pgQueryStart.publish(query)
      mysql2OuterQueryStart.publish({ sql: 'SELECT 1' })

      sinon.assert.calledOnce(waf.runSubContext)
    })

    it('invalidates the originating request without invalidating the active request', () => {
      const first = {}
      const second = {}
      enterStore(withRequest(undefined, first))
      pgQueryStart.publish(query)
      enterStore(withRequest(undefined, second))
      pgQueryStart.publish(query)

      wafRunFinished.publish({ req: first, payload: { [addresses.HTTP_INCOMING_BODY]: 'new input' } })
      pgQueryStart.publish(query)
      sinon.assert.calledTwice(waf.runSubContext)

      enterStore(withRequest(undefined, first))
      pgQueryStart.publish(query)
      sinon.assert.calledThrice(waf.runSubContext)
    })

    it('invalidates queries when resolver inputs are evaluated in a subcontext', () => {
      const req = {}
      enterStore(withRequest(undefined, req))
      pgQueryStart.publish(query)
      wafRunFinished.publish({
        req,
        payload: { [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { field: {} } },
        isSubcontext: true,
      })
      pgQueryStart.publish(query)

      sinon.assert.calledTwice(waf.runSubContext)
    })
  })

  describe('analyzeMysql2SqlInjection', () => {
    it('should analyze sql injection', () => {
      const ctx = {
        sql: 'SELECT 1',
      }
      const req = {}
      enterStore(withRequest(undefined, req))

      mysql2OuterQueryStart.publish(ctx)

      const subcontextData = {
        [addresses.DB_STATEMENT]: 'SELECT 1',
        [addresses.DB_SYSTEM]: 'mysql',
      }
      sinon.assert.calledOnceWithExactly(waf.runSubContext, subcontextData, { type: 'sql_injection' })
    })

    it('should not analyze sql injection if rasp is disabled', () => {
      sqli.disable()

      const ctx = {
        sql: 'SELECT 1',
      }
      const req = {}
      enterStore(withRequest(undefined, req))

      mysql2OuterQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.runSubContext)
    })

    it('should not analyze sql injection if no store', () => {
      const ctx = {
        sql: 'SELECT 1',
      }
      enterStore(undefined)

      mysql2OuterQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.runSubContext)
    })

    it('should not analyze sql injection if no req', () => {
      const ctx = {
        sql: 'SELECT 1',
      }
      enterStore({})

      mysql2OuterQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.runSubContext)
    })

    it('should not analyze sql injection if no query', () => {
      const ctx = {
        sql: 'SELECT 1',
      }
      enterStore({})

      mysql2OuterQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.runSubContext)
    })
  })
})
