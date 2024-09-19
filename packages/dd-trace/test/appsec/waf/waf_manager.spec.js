'use strict'

const proxyquire = require('proxyquire')

describe('WAFManager', () => {
  let WAFManager, WAFContextWrapper, DDWAF
  const knownAddresses = new Set()

  beforeEach(() => {
    DDWAF = sinon.stub()
    DDWAF.prototype.constructor.version = sinon.stub()
    DDWAF.prototype.knownAddresses = knownAddresses
    DDWAF.prototype.diagnostics = {}
    DDWAF.prototype.createContext = sinon.stub()

    WAFContextWrapper = sinon.stub()
    WAFManager = proxyquire('../../../src/appsec/waf/waf_manager', {
      './waf_context_wrapper': WAFContextWrapper,
      '@datadog/native-appsec': { DDWAF }
    })
  })

  describe('getWAFContext', () => {
    it('should construct WAFContextWrapper with knownAddresses', () => {
      const wafManager = new WAFManager({}, {})

      wafManager.getWAFContext({})

      const any = sinon.match.any
      sinon.assert.calledOnceWithMatch(WAFContextWrapper, any, any, any, any, knownAddresses)
    })
  })
})
