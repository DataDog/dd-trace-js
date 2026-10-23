'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const getDBInformation = require('../src/connection-parser')

describe('oracledb connection parser', () => {
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
