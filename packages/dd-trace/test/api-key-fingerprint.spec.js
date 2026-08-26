'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { createAPIKeyFingerprint } = require('../src/api-key-fingerprint')

describe('API key fingerprint', () => {
  for (const [apiKey, fingerprint] of [
    ['padding-171', 'rijn_053ybBRXypQt9AC6UIlqH1YCFYSV1rQl8HCDIcBZs3D'],
    ['!@#$%^𐍈한€हИ£', 'rijn_eFLHeyLxwaiNs2hY16pjkjNjVSHWRgf2rlveKc8YA1K'],
    ['secret', 'rijn_amLaG4Pd6h6t9VtJna81k744P1DYxGHzIJ6ECO3OOMj'],
    ['system-tests-mock-api-key', 'rijn_Fc1Sxm6lPHiKU1IdWeNqpcVZiiW3C2LXJLqQp670sFU'],
  ]) {
    it(`creates the canonical fixed-width fingerprint for ${JSON.stringify(apiKey)}`, () => {
      const result = createAPIKeyFingerprint(apiKey)

      assert.strictEqual(result, fingerprint)
      assert.strictEqual(result.length, 48)
    })
  }
})
