'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../dd-trace/src/log')
const getDBInformation = require('../src/connection-parser')

describe('oracledb connection parser', () => {
  for (const connectString of [
    'db.example:1522/service',
    '(DESCRIPTION=(ADDRESS=(HOST=db.example)(PORT=1522))(CONNECT_DATA=(SERVICE_NAME=service)))',
  ]) {
    it('reuses the last parsed connection string across connections', () => {
      const first = getDBInformation({ connectString })
      assert.strictEqual(getDBInformation({ connectionString: connectString }), first)
      assert.strictEqual(getDBInformation({ connectString: ` ${connectString} ` }), first)
    })
  }

  it('refreshes metadata when the connection string changes', () => {
    const attrs = { connectString: 'first.example:1522/first' }
    const first = getDBInformation(attrs)
    attrs.connectString = 'second.example:1523/second'
    assert.deepStrictEqual(getDBInformation(attrs), {
      hostname: 'second.example',
      port: '1523',
      dbInstance: 'second',
    })
    attrs.connectString = 'first.example:1522/first'
    assert.deepStrictEqual(getDBInformation(attrs), first)
  })

  it('preserves default fields for URLs and descriptors', () => {
    for (const connectString of ['db.example', '(DESCRIPTION=(ADDRESS=(HOST=db.example)))']) {
      assert.deepStrictEqual(getDBInformation({ connectString }), {
        hostname: 'db.example',
        port: '1521',
        dbInstance: 'XEPDB1',
      })
    }
    assert.deepStrictEqual(getDBInformation({ connectString: '(DESCRIPTION=(CONNECT_DATA=(SID=service)))' }), {
      hostname: 'localhost',
      port: '1521',
      dbInstance: 'service',
    })
    assert.deepStrictEqual(getDBInformation({}), {
      hostname: 'localhost',
      port: '1521',
      dbInstance: 'XEPDB1',
    })
  })

  it('logs each invalid connection string without caching errors', () => {
    const error = sinon.stub(log, 'error')
    try {
      assert.deepStrictEqual(getDBInformation({ connectString: 'tcp://[invalid' }), {})
      assert.deepStrictEqual(getDBInformation({ connectString: 'tcp://[invalid' }), {})
      assert.strictEqual(error.callCount, 2)
      assert.strictEqual(error.firstCall.args[0], 'Invalid oracle connection string')
    } finally {
      error.restore()
    }
  })

  it('parses Easy Connect strings without a protocol', () => {
    assert.deepStrictEqual(getDBInformation({ connectString: 'db.example:1522/service' }), {
      hostname: 'db.example',
      port: '1522',
      dbInstance: 'service',
    })
  })

  for (const protocol of ['tcp', 'tcps']) {
    it(`parses ${protocol} Easy Connect URLs`, () => {
      assert.deepStrictEqual(getDBInformation({
        connectString: `${protocol}://db.example:1522/service`,
      }), {
        hostname: 'db.example',
        port: '1522',
        dbInstance: 'service',
      })
    })
  }
})
