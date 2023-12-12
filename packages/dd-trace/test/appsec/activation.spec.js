'use strict'

const Activation = require('../../src/appsec/activation')

describe('Appsec Activation', () => {
  let config

  beforeEach(() => {
    config = {
      appsec: {}
    }
  })

  it('should return OneClick with undefined value', () => {
    config.appsec.enabled = undefined
    const activation = Activation.fromConfig(config)

    expect(activation).to.equal(Activation.OneClick)
  })

  it('should return Enabled with true value', () => {
    config.appsec.enabled = true
    const activation = Activation.fromConfig(config)

    expect(activation).to.equal(Activation.Enabled)
  })

  it('should return Disabled with false value', () => {
    config.appsec.enabled = false
    const activation = Activation.fromConfig(config)

    expect(activation).to.equal(Activation.Disabled)
  })

  it('should return Disabled with invalid value', () => {
    config.appsec.enabled = 'invalid'
    const activation = Activation.fromConfig(config)

    expect(activation).to.equal(Activation.Disabled)
  })
})
