'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

describe('WAFManager', () => {
  let WAFManager, WAFContextWrapper, DDWAF, log, Reporter

  const knownAddresses = new Set()

  beforeEach(() => {
    DDWAF = sinon.stub()
    DDWAF.version = sinon.stub()
    DDWAF.prototype.knownAddresses = knownAddresses
    DDWAF.prototype.diagnostics = {}
    DDWAF.prototype.createContext = sinon.stub()

    WAFContextWrapper = sinon.stub()
    log = { error: sinon.stub() }
    Reporter = { reportWafInit: sinon.stub() }

    WAFManager = proxyquire('../../../src/appsec/waf/waf_manager', {
      './waf_context_wrapper': WAFContextWrapper,
      '@datadog/native-appsec': { DDWAF },
      '../../log': log,
      '../reporter': Reporter,
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

  describe('_loadDDWAF', () => {
    it('should log the original error when the native package fails to load', () => {
      const err = new Error('unsupported platform')
      DDWAF.version.throws(err)

      assert.throws(() => new WAFManager({}, {}), err)

      sinon.assert.calledOnceWithExactly(
        log.error,
        '[ASM] AppSec could not load native package. In-app WAF features will not be available.',
        err
      )
      sinon.assert.calledOnceWithExactly(Reporter.reportWafInit, 'unknown', 'unknown')
    })
  })
})
