'use strict'

const { pgQueryStart, mysql2OuterQueryStart } = require('../../../src/appsec/channels')
const addresses = require('../../../src/appsec/addresses')
const proxyquire = require('proxyquire')

describe('RASP - sql_injection', () => {
  let waf, datadogCore, sqli

  beforeEach(() => {
    datadogCore = {
      storage: {
        getStore: sinon.stub()
      }
    }

    waf = {
      run: sinon.stub()
    }

    sqli = proxyquire('../../../src/appsec/rasp/sql_injection', {
      '../../../../datadog-core': datadogCore,
      '../waf': waf
    })

    const config = {
      appsec: {
        stackTrace: {
          enabled: true,
          maxStackTraces: 2,
          maxDepth: 42
        }
      }
    }

    sqli.enable(config)
  })

  afterEach(() => {
    sinon.restore()
    sqli.disable()
  })

  describe('analyzePgSqlInjection', () => {
    it('should analyze sql injection', () => {
      const ctx = {
        query: {
          text: 'SELECT 1'
        }
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      pgQueryStart.publish(ctx)

      const persistent = {
        [addresses.DB_STATEMENT]: 'SELECT 1',
        [addresses.DB_SYSTEM]: 'postgresql'
      }
      sinon.assert.calledOnceWithExactly(waf.run, { persistent }, req, { type: 'sql_injection' })
    })

    it('should not analyze sql injection if rasp is disabled', () => {
      sqli.disable()

      const ctx = {
        query: {
          text: 'SELECT 1'
        }
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      pgQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze sql injection if no store', () => {
      const ctx = {
        query: {
          text: 'SELECT 1'
        }
      }
      datadogCore.storage.getStore.returns(undefined)

      pgQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze sql injection if no req', () => {
      const ctx = {
        query: {
          text: 'SELECT 1'
        }
      }
      datadogCore.storage.getStore.returns({})

      pgQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze sql injection if no query', () => {
      const ctx = {
        query: {}
      }
      datadogCore.storage.getStore.returns({})

      pgQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })
  })

  describe('analyzeMysql2SqlInjection', () => {
    it('should analyze sql injection', () => {
      const ctx = {
        sql: 'SELECT 1'
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      mysql2OuterQueryStart.publish(ctx)

      const persistent = {
        [addresses.DB_STATEMENT]: 'SELECT 1',
        [addresses.DB_SYSTEM]: 'mysql'
      }
      sinon.assert.calledOnceWithExactly(waf.run, { persistent }, req, { type: 'sql_injection' })
    })

    it('should not analyze sql injection if rasp is disabled', () => {
      sqli.disable()

      const ctx = {
        sql: 'SELECT 1'
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      mysql2OuterQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze sql injection if no store', () => {
      const ctx = {
        sql: 'SELECT 1'
      }
      datadogCore.storage.getStore.returns(undefined)

      mysql2OuterQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze sql injection if no req', () => {
      const ctx = {
        sql: 'SELECT 1'
      }
      datadogCore.storage.getStore.returns({})

      mysql2OuterQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze sql injection if no query', () => {
      const ctx = {
        sql: 'SELECT 1'
      }
      datadogCore.storage.getStore.returns({})

      mysql2OuterQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })
  })
})
