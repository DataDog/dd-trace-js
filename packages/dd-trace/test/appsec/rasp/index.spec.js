'use strict'

const proxyquire = require('proxyquire')
const { httpClientRequestStart } = require('../../../src/appsec/channels')
const addresses = require('../../../src/appsec/addresses')

describe('RASP', () => {
  let waf, rasp, datadogCore
  beforeEach(() => {
    datadogCore = {
      storage: {
        getStore: sinon.stub()
      }
    }
    waf = {
      run: sinon.stub()
    }

    rasp = proxyquire('../../../src/appsec/rasp', {
      '../../../../datadog-core': datadogCore,
      '../waf': waf
    })

    rasp.enable()
  })

  afterEach(() => {
    rasp.disable()
  })

  describe('analyzeSsrf', () => {
    it('should analyze ssrf', () => {
      const ctx = {
        args: {
          uri: 'http://example.com'
        }
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      httpClientRequestStart.publish(ctx)

      const persistent = { [addresses.RASP_IO_URL]: 'http://example.com' }
      sinon.assert.calledOnce(waf.run)
      sinon.assert.calledWith(waf.run, { persistent }, req)
    })

    it('should not analyze ssrf if rasp is disabled', () => {
      rasp.disable()
      const ctx = {
        args: {
          uri: 'http://example.com'
        }
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze ssrf if no store', () => {
      const ctx = {
        args: {
          uri: 'http://example.com'
        }
      }
      datadogCore.storage.getStore.returns(undefined)

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze ssrf if no req', () => {
      const ctx = {
        args: {
          uri: 'http://example.com'
        }
      }
      datadogCore.storage.getStore.returns({})

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })
  })
})
