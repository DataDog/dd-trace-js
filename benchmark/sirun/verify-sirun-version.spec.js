'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { assertSirunVersion } = require('./verify-sirun-version')

describe('Sirun version verification', () => {
  it('accepts readiness-capable versions', () => {
    assert.doesNotThrow(() => assertSirunVersion('sirun 0.1.12'))
    assert.doesNotThrow(() => assertSirunVersion('sirun 1.0.0'))
  })

  it('rejects older versions', () => {
    assert.throws(() => assertSirunVersion('sirun 0.1.11'), /0\.1\.12 or newer/)
  })

  it('rejects unrecognized output', () => {
    assert.throws(() => assertSirunVersion('sirun dev'), /Could not parse/)
  })
})
