'use strict'

const assert = require('node:assert/strict')

const axios = require('axios')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const iast = require('../../../src/appsec/iast')
const iastContextFunctions = require('../../../src/appsec/iast/iast-context')
const overheadController = require('../../../src/appsec/iast/overhead-controller')
const vulnerabilityReporter = require('../../../src/appsec/iast/vulnerability-reporter')
const { IAST_MODULE } = require('../../../src/appsec/rasp/fs-plugin')
const { getConfigFresh } = require('../../helpers/config')
const agent = require('../../plugins/agent')
const { assertObjectContains } = require('../../../../../integration-tests/helpers')
const { testInRequest } = require('./utils')

describe('IAST Index', () => {
  beforeEach(() => {
    vulnerabilityReporter.clearCache()
  })

  describe('full feature', () => {
    function app () {
      const crypto = require('crypto')
      crypto.createHash('sha1')
    }

    function tests (config) {
      describe('with disabled iast', () => {
        beforeEach(() => {
          iast.disable()
        })

        it('should not have any vulnerability', (done) => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['_dd.iast.json'], undefined)
            })
            .then(done)
            .catch(done)
          axios.get(`http://localhost:${config.port}/`).catch(done)
        })
      })

      describe('with enabled iast', () => {
        const originalCleanIastContext = iastContextFunctions.cleanIastContext
        const originalReleaseRequest = overheadController.releaseRequest

        beforeEach(() => {
          iast.enable(getConfigFresh({
            experimental: {
              iast: {
                enabled: true,
                requestSampling: 100,
              },
            },
          }))
        })

        afterEach(() => {
          iastContextFunctions.cleanIastContext = originalCleanIastContext
          overheadController.releaseRequest = originalReleaseRequest
          iast.disable()
        })

        it('should detect vulnerability', (done) => {
          agent
            .assertSomeTraces(traces => {
              assertObjectContains(
                JSON.parse(traces[0][0].meta['_dd.iast.json']),
                { vulnerabilities: [{ type: 'WEAK_HASH' }] }
              )
            })
            .then(done)
            .catch(done)
          axios.get(`http://localhost:${config.port}/`).catch(done)
        })

        it('should call to cleanIastContext', (done) => {
          const mockedCleanIastContext = sinon.stub()
          iastContextFunctions.cleanIastContext = mockedCleanIastContext
          agent
            .assertSomeTraces(traces => {
              assertObjectContains(
                JSON.parse(traces[0][0].meta['_dd.iast.json']),
                { vulnerabilities: [{ type: 'WEAK_HASH' }] }
              )
              sinon.assert.calledOnce(mockedCleanIastContext)
            })
            .then(done)
            .catch(done)
          axios.get(`http://localhost:${config.port}/`).catch(done)
        })

        it('should call to overhead controller release', (done) => {
          const releaseRequest = sinon.stub().callsFake(originalReleaseRequest)
          overheadController.releaseRequest = releaseRequest
          agent
            .assertSomeTraces(traces => {
              assertObjectContains(
                JSON.parse(traces[0][0].meta['_dd.iast.json']),
                { vulnerabilities: [{ type: 'WEAK_HASH' }] }
              )
              sinon.assert.calledOnce(releaseRequest)
            })
            .then(done)
            .catch(done)
          axios.get(`http://localhost:${config.port}/`).catch(done)
        })
      })
    }

    testInRequest(app, tests)
  })

  describe('unit test', () => {
    let mockVulnerabilityReporter
    let mockIast
    let mockOverheadController
    let appsecFsPlugin
    let analyzers

    const config = getConfigFresh({
      experimental: {
        iast: {
          enabled: true,
          requestSampling: 100,
        },
      },
    })

    beforeEach(() => {
      mockVulnerabilityReporter = {
        start: sinon.stub(),
        stop: sinon.stub(),
        sendVulnerabilities: sinon.stub(),
      }
      mockOverheadController = {
        acquireRequest: sinon.stub(),
        releaseRequest: sinon.stub(),
        initializeRequestContext: sinon.stub(),
        startGlobalContext: sinon.stub(),
        finishGlobalContext: sinon.stub(),
      }
      appsecFsPlugin = {
        enable: sinon.stub(),
        disable: sinon.stub(),
      }
      analyzers = {
        enableAllAnalyzers: sinon.stub(),
      }
      mockIast = proxyquire('../../../src/appsec/iast', {
        './vulnerability-reporter': mockVulnerabilityReporter,
        './overhead-controller': mockOverheadController,
        '../rasp/fs-plugin': appsecFsPlugin,
        './analyzers': analyzers,
      })
    })

    afterEach(() => {
      sinon.restore()
      mockIast.disable()
    })

    describe('enable', () => {
      it('should enable AppsecFsPlugin', () => {
        mockIast.enable(config)
        sinon.assert.calledOnceWithExactly(appsecFsPlugin.enable, IAST_MODULE)
        assert.strictEqual(analyzers.enableAllAnalyzers.calledAfter(appsecFsPlugin.enable), true)
      })
    })

    describe('disable', () => {
      it('should disable AppsecFsPlugin', () => {
        mockIast.enable(config)
        mockIast.disable()
        sinon.assert.calledOnceWithExactly(appsecFsPlugin.disable, IAST_MODULE)
      })
    })

    describe('managing overhead controller global context', () => {
      it('should start global context refresher on iast enabled', () => {
        mockIast.enable(config)
        sinon.assert.calledOnce(mockOverheadController.startGlobalContext)
      })

      it('should finish global context refresher on iast disabled', () => {
        mockIast.enable(config)

        mockIast.disable()
        sinon.assert.calledOnce(mockOverheadController.finishGlobalContext)
      })

      it('should start global context only once when calling enable multiple times', () => {
        mockIast.enable(config)
        mockIast.enable(config)

        sinon.assert.calledOnce(mockOverheadController.startGlobalContext)
      })

      it('should not finish global context if not enabled before ', () => {
        mockIast.disable(config)

        sinon.assert.notCalled(mockOverheadController.finishGlobalContext)
      })
    })

    describe('managing vulnerability reporter', () => {
      it('should start vulnerability reporter on iast enabled', () => {
        const fakeTracer = {}
        mockIast.enable(config, fakeTracer)
        sinon.assert.calledOnceWithExactly(mockVulnerabilityReporter.start, config, fakeTracer)
      })

      it('should stop vulnerability reporter on iast disabled', () => {
        mockIast.enable(config)

        mockIast.disable()
        sinon.assert.calledOnce(mockVulnerabilityReporter.stop)
      })
    })

    describe('onIncomingHttpRequestStart', () => {
      it('should not fail with unexpected data', () => {
        iast.onIncomingHttpRequestStart()
        iast.onIncomingHttpRequestStart(null)
        iast.onIncomingHttpRequestStart({})
      })

      it('should not fail with unexpected store', () => {
        iast.onIncomingHttpRequestStart({ req: {} })
      })
    })

    describe('onIncomingHttpRequestEnd', () => {
      it('should not fail without unexpected data', () => {
        mockIast.onIncomingHttpRequestEnd()
        mockIast.onIncomingHttpRequestEnd(null)
        mockIast.onIncomingHttpRequestEnd({})
      })

      it('should not call send vulnerabilities without context', () => {
        mockIast.onIncomingHttpRequestEnd({ req: {} })
        sinon.assert.notCalled(mockVulnerabilityReporter.sendVulnerabilities)
      })

      it('should not call send vulnerabilities with context but without iast context', () => {
        mockIast.onIncomingHttpRequestEnd({ req: {} })
        sinon.assert.notCalled(mockVulnerabilityReporter.sendVulnerabilities)
      })

      it('should not call releaseRequest without iast context', () => {
        mockIast.onIncomingHttpRequestEnd({ req: {} })
        sinon.assert.notCalled(mockOverheadController.releaseRequest)
      })
    })
  })
})
