'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const poolAcquireSource = require('../src/pool-acquire-source')

describe('MariaDB pool-acquire source', () => {
  it('normalizes connection configuration without exposing credentials', () => {
    assert.deepStrictEqual(poolAcquireSource.start({
      conf: {
        database: 'database',
        host: 'localhost',
        password: 'secret',
        port: 3306,
        user: 'user',
      },
      startTime: 42,
    }), {
      connection: {
        database: 'database',
        host: 'localhost',
        port: 3306,
        user: 'user',
      },
      startTime: 42,
    })
  })

  it('reports pool wait metadata only when timing is available', () => {
    assert.deepStrictEqual(
      poolAcquireSource.complete({ poolWaitTime: 12.5 }),
      { 'mariadb.pool.wait_time': 12.5 }
    )
    assert.strictEqual(poolAcquireSource.complete({}), undefined)
  })
})
