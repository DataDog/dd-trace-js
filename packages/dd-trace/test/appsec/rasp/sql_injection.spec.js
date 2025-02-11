'use strict'

const { pgQueryStart, mysql2OuterQueryStart } = require('../../../src/appsec/channels')
const addresses = require('../../../src/appsec/addresses')
const proxyquire = require('proxyquire')

describe('RASP - sql_injection', () => {
  let waf, legacyStorage, sqli

  beforeEach(() => {
    legacyStorage = {
      getStore: sinon.stub()
    }

    waf = {
      run: sinon.stub()
    }

    sqli = proxyquire('../../../src/appsec/rasp/sql_injection', {
      '../../../../datadog-core': { storage: () => legacyStorage },
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
      legacyStorage.getStore.returns({ req })

      pgQueryStart.publish(ctx)

      const ephemeral = {
        [addresses.DB_STATEMENT]: 'SELECT 1',
        [addresses.DB_SYSTEM]: 'postgresql'
      }
      sinon.assert.calledOnceWithExactly(waf.run, { ephemeral }, req, { type: 'sql_injection' })
    })

    it('should not analyze sql injection if rasp is disabled', () => {
      sqli.disable()

      const ctx = {
        query: {
          text: 'SELECT 1'
        }
      }
      const req = {}
      legacyStorage.getStore.returns({ req })

      pgQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze sql injection if no store', () => {
      const ctx = {
        query: {
          text: 'SELECT 1'
        }
      }
      legacyStorage.getStore.returns(undefined)

      pgQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze sql injection if no req', () => {
      const ctx = {
        query: {
          text: 'SELECT 1'
        }
      }
      legacyStorage.getStore.returns({})

      pgQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze sql injection if no query', () => {
      const ctx = {
        query: {}
      }
      legacyStorage.getStore.returns({})

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
      legacyStorage.getStore.returns({ req })

      mysql2OuterQueryStart.publish(ctx)

      const ephemeral = {
        [addresses.DB_STATEMENT]: 'SELECT 1',
        [addresses.DB_SYSTEM]: 'mysql'
      }
      sinon.assert.calledOnceWithExactly(waf.run, { ephemeral }, req, { type: 'sql_injection' })
    })

    it('should not analyze sql injection if rasp is disabled', () => {
      sqli.disable()

      const ctx = {
        sql: 'SELECT 1'
      }
      const req = {}
      legacyStorage.getStore.returns({ req })

      mysql2OuterQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze sql injection if no store', () => {
      const ctx = {
        sql: 'SELECT 1'
      }
      legacyStorage.getStore.returns(undefined)

      mysql2OuterQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze sql injection if no req', () => {
      const ctx = {
        sql: 'SELECT 1'
      }
      legacyStorage.getStore.returns({})

      mysql2OuterQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze sql injection if no query', () => {
      const ctx = {
        sql: 'SELECT 1'
      }
      legacyStorage.getStore.returns({})

      mysql2OuterQueryStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })
  })
})
