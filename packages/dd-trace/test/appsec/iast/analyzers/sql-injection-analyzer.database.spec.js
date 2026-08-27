'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../../../../datadog-core')
const analyzer = require('../../../../src/appsec/iast/analyzers/sql-injection-analyzer')
const { getEventSourceRegistry } = require('../../../../src/events/source-registry')
require('../../../../../datadog-plugin-mariadb/src')

const legacyStorage = storage('legacy')

describe('sql-injection-analyzer database contributor', () => {
  afterEach(() => {
    analyzer.configure(false)
    sinon.restore()
  })

  it('analyzes sanitized MariaDB facts without an APM consumer', () => {
    const analyze = sinon.stub(analyzer, 'analyze')
    const sourceRegistry = getEventSourceRegistry()
    analyzer.configure(true)

    const runtime = sourceRegistry.getSource('db.query', 'mariadb')
    assert.strictEqual(runtime.consumers.size, 0)
    assert.strictEqual(runtime.active, true)

    const parentStore = { iastContext: true }
    const context = {
      conf: {
        database: 'database',
        host: 'localhost',
        password: 'secret',
        port: 3306,
        user: 'user',
      },
      sql: 'SELECT 1',
    }
    legacyStorage.run(parentStore, () => {
      dc.channel('apm:mariadb:query:start').runStores(context, () => {
        const store = legacyStorage.getStore()
        assert.strictEqual(store.sqlAnalyzed, true)
        assert.strictEqual(store.sqlParentStore, parentStore)
        assert.strictEqual(store.span, undefined)
      })
    })
    dc.channel('apm:mariadb:query:finish').runStores(context, () => {
      assert.strictEqual(legacyStorage.getStore(), parentStore)
    })

    sinon.assert.calledOnceWithExactly(analyze, 'SELECT 1', parentStore, 'MYSQL')
    analyzer.configure(false)
    assert.strictEqual(runtime.active, false)
  })
})
