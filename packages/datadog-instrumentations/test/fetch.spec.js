'use strict'

const assert = require('node:assert/strict')

const { before, describe, it } = require('mocha')

describe('packages/datadog-instrumentations/src/fetch.js', () => {
  describe('globalThis.fetch identity', () => {
    let nameBefore

    before(() => {
      nameBefore = globalThis.fetch.name
      require('../src/fetch')
    })

    it('preserves the fetch function name after dd-trace loads', () => {
      assert.equal(nameBefore, 'fetch')
      assert.equal(globalThis.fetch.name, 'fetch')
    })

    it('forwards calls to the wrapped fetch without recursion', () => {
      return assert.rejects(globalThis.fetch('not-a-real-protocol://x'), TypeError)
    })
  })
})
