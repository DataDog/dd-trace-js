'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const querySource = require('../src/query-source')

describe('MariaDB query source', () => {
  it('normalizes connection, statement, and pool wait facts', () => {
    const context = {
      conf: {
        database: 'database',
        host: 'localhost',
        password: 'secret',
        port: 3306,
        user: 'user',
      },
      poolWaitTime: 12.5,
      sql: 'SELECT 1',
    }

    assert.deepStrictEqual(querySource.start(context), {
      connection: {
        database: 'database',
        host: 'localhost',
        port: 3306,
        user: 'user',
      },
      statement: 'SELECT 1',
      tags: { 'mariadb.pool.wait_time': 12.5 },
    })
  })

  it('normalizes an object query without exposing driver options', () => {
    assert.deepStrictEqual(querySource.start({
      conf: {},
      sql: { namedPlaceholders: true, sql: 'SELECT :value' },
    }), {
      connection: {
        database: undefined,
        host: undefined,
        port: undefined,
        user: undefined,
      },
      statement: 'SELECT :value',
    })
  })

  it('writes updated statements back to string and object query shapes', () => {
    const stringContext = { sql: 'SELECT 1' }
    const objectContext = { sql: { namedPlaceholders: true, sql: 'SELECT :value' } }

    querySource.updateSource(stringContext, {}, { statement: '/*dbm*/ SELECT 1' })
    querySource.updateSource(objectContext, {}, { statement: '/*dbm*/ SELECT :value' })

    assert.strictEqual(stringContext.sql, '/*dbm*/ SELECT 1')
    assert.deepStrictEqual(objectContext.sql, {
      namedPlaceholders: true,
      sql: '/*dbm*/ SELECT :value',
    })
  })
})
