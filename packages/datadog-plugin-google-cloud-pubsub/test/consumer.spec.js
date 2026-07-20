'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')
const proxyquire = require('proxyquire')

describe('google-cloud-pubsub consumer', () => {
  describe('when FinalizationRegistry is unavailable', () => {
    let realFinalizationRegistry

    afterEach(() => {
      globalThis.FinalizationRegistry = realFinalizationRegistry
    })

    it('should not throw when the module is loaded', () => {
      realFinalizationRegistry = globalThis.FinalizationRegistry
      delete globalThis.FinalizationRegistry

      let caught
      try {
        proxyquire('../src/consumer', {})
      } catch (e) {
        caught = e
      }

      assert.strictEqual(caught, undefined)
    })
  })
})
