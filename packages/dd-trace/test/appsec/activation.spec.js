'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')

const Activation = require('../../src/appsec/activation')

describe('Appsec Activation', () => {
  let config

  beforeEach(() => {
    config = {
      appsec: {}
    }
  })

  it('should return ONECLICK with undefined value', () => {
    config.appsec.enabled = undefined
    const activation = Activation.fromConfig(config)

    assert.strictEqual(activation, Activation.ONECLICK)
  })

  it('should return ENABLED with true value', () => {
    config.appsec.enabled = true
    const activation = Activation.fromConfig(config)

    assert.strictEqual(activation, Activation.ENABLED)
  })

  it('should return DISABLED with false value', () => {
    config.appsec.enabled = false
    const activation = Activation.fromConfig(config)

    assert.strictEqual(activation, Activation.DISABLED)
  })

  it('should return DISABLED with invalid value', () => {
    config.appsec.enabled = 'invalid'
    const activation = Activation.fromConfig(config)

    assert.strictEqual(activation, Activation.DISABLED)
  })
})
