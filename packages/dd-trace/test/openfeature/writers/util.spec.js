'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('OpenFeature writer strategy', () => {
  let config
  let discoverEVPProxy
  let log
  let setAgentStrategy

  beforeEach(() => {
    config = { url: new URL('http://localhost:8126') }
    discoverEVPProxy = sinon.stub()
    log = { debug: sinon.stub() }

    ;({ setAgentStrategy } = proxyquire('../../../src/openfeature/writers/util', {
      '../../evp_proxy/discovery': { discoverEVPProxy },
      '../../log': log,
    }))
  })

  it('discovers Agent EVP v2 and returns a plain route', () => {
    const route = {
      url: config.url,
      basePath: '/evp_proxy/v2',
    }
    discoverEVPProxy.yields(null, route)
    const callback = sinon.stub()

    setAgentStrategy(config, callback)

    sinon.assert.calledOnceWithExactly(discoverEVPProxy, config.url, {
      supportedPaths: ['/evp_proxy/v2'],
    }, sinon.match.func)
    sinon.assert.calledOnceWithExactly(callback, true, route)
  })

  it('disables exposure delivery when no compatible route exists', () => {
    discoverEVPProxy.yields(null)
    const callback = sinon.stub()

    setAgentStrategy(config, callback)

    sinon.assert.calledOnceWithExactly(callback, false)
  })

  it('disables exposure delivery when discovery fails', () => {
    const expectedError = new Error('Agent unavailable')
    discoverEVPProxy.yields(expectedError)
    const callback = sinon.stub()

    setAgentStrategy(config, callback)

    sinon.assert.calledOnceWithExactly(callback, false)
    assert.match(log.debug.firstCall.args[0], /error getting agent info/)
  })
})
