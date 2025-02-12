'use strict'

const proxyquire = require('proxyquire')
const { httpClientRequestStart } = require('../../../src/appsec/channels')
const addresses = require('../../../src/appsec/addresses')

describe('RASP - ssrf.js', () => {
  let waf, legacyStorage, ssrf

  beforeEach(() => {
    legacyStorage = {
      getStore: sinon.stub()
    }

    waf = {
      run: sinon.stub()
    }

    ssrf = proxyquire('../../../src/appsec/rasp/ssrf', {
      '../../../../datadog-core': { storage: () => legacyStorage },
      '../waf': waf
    })

    const config = {
      appsec: {
        stackTrace: {
          enabled: true,
          maxStackTraces: 2,
          maxDepth: 42
        }
      }
    }

    ssrf.enable(config)
  })

  afterEach(() => {
    sinon.restore()
    ssrf.disable()
  })

  describe('analyzeSsrf', () => {
    it('should analyze ssrf', () => {
      const ctx = {
        args: {
          uri: 'http://example.com'
        }
      }
      const req = {}
      legacyStorage.getStore.returns({ req })

      httpClientRequestStart.publish(ctx)

      const ephemeral = { [addresses.HTTP_OUTGOING_URL]: 'http://example.com' }
      sinon.assert.calledOnceWithExactly(waf.run, { ephemeral }, req, { type: 'ssrf' })
    })

    it('should not analyze ssrf if rasp is disabled', () => {
      ssrf.disable()
      const ctx = {
        args: {
          uri: 'http://example.com'
        }
      }
      const req = {}
      legacyStorage.getStore.returns({ req })

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze ssrf if no store', () => {
      const ctx = {
        args: {
          uri: 'http://example.com'
        }
      }
      legacyStorage.getStore.returns(undefined)

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze ssrf if no req', () => {
      const ctx = {
        args: {
          uri: 'http://example.com'
        }
      }
      legacyStorage.getStore.returns({})

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze ssrf if no url', () => {
      const ctx = {
        args: {}
      }
      legacyStorage.getStore.returns({})

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })
  })
})
