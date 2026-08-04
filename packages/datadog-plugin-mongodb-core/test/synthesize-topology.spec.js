'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../../dd-trace/test/setup/core')

const { synthesizeTopology } = require('../../datadog-instrumentations/src/mongodb-core')

const EMPTY_TOPOLOGY = { s: { options: {} } }

describe('mongodb-core synthesizeTopology', () => {
  it('parses a standard `host:port` address', () => {
    assert.deepStrictEqual(
      synthesizeTopology('127.0.0.1:27017'),
      { s: { options: { host: '127.0.0.1', port: '27017' } } }
    )
  })

  it('returns the empty-options envelope for an IPv6 form (multiple colons)', () => {
    assert.deepStrictEqual(synthesizeTopology('[::1]:27017'), EMPTY_TOPOLOGY)
    assert.deepStrictEqual(synthesizeTopology('::1:27017'), EMPTY_TOPOLOGY)
  })

  it('returns the empty-options envelope for a random-UUID address (no colon)', () => {
    assert.deepStrictEqual(synthesizeTopology('e8a93f01-1234-5678-9abc-def012345678'), EMPTY_TOPOLOGY)
  })

  it('returns the empty-options envelope when the port half is empty', () => {
    // Boundary: previous `address.split(':').length === 2` accepted these and
    // tagged `host=host, port=''` / `host='', port='27017'`. The tightened
    // gate rejects either side being empty.
    assert.deepStrictEqual(synthesizeTopology('host:'), EMPTY_TOPOLOGY)
    assert.deepStrictEqual(synthesizeTopology(':27017'), EMPTY_TOPOLOGY)
    assert.deepStrictEqual(synthesizeTopology(':'), EMPTY_TOPOLOGY)
  })

  it('returns the empty-options envelope for non-string addresses', () => {
    assert.deepStrictEqual(synthesizeTopology(undefined), EMPTY_TOPOLOGY)
    assert.deepStrictEqual(synthesizeTopology(null), EMPTY_TOPOLOGY)
    assert.deepStrictEqual(synthesizeTopology(12_345), EMPTY_TOPOLOGY)
  })
})
