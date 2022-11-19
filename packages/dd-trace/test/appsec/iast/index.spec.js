'use strict'

require('../../setup/core')

const proxyquire = require('proxyquire')
const Config = require('../../../src/config')
const agent = require('../../plugins/agent')
const axios = require('axios')
const iast = require('../../../src/appsec/iast')
const iastContextFunctions = require('../../../src/appsec/iast/iast-context')
const overheadController = require('../../../src/appsec/iast/overhead-controller')
const vulnerabilityReporter = require('../../../src/appsec/iast/vulnerability-reporter')
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
            .use(traces => {
              expect(traces[0][0].meta['_dd.iast.json']).to.be.undefined
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
          iast.enable(new Config({
            experimental: {
              iast: {
                enabled: true,
                requestSampling: 100
              }
            }
          }))
        })

        afterEach(() => {
          iastContextFunctions.cleanIastContext = originalCleanIastContext
          overheadController.releaseRequest = originalReleaseRequest
          iast.disable()
        })

        it('should detect vulnerability', (done) => {
          agent
            .use(traces => {
              expect(traces[0][0].meta['_dd.iast.json']).to.include('"WEAK_HASH"')
            })
            .then(done)
            .catch(done)
          axios.get(`http://localhost:${config.port}/`).catch(done)
        })

        it('should call to cleanIastContext', (done) => {
          const mockedCleanIastContext = sinon.stub()
          iastContextFunctions.cleanIastContext = mockedCleanIastContext
          agent
            .use(traces => {
              expect(traces[0][0].meta['_dd.iast.json']).to.include('"WEAK_HASH"')
              expect(mockedCleanIastContext).to.have.been.calledOnce
            })
            .then(done)
            .catch(done)
          axios.get(`http://localhost:${config.port}/`).catch(done)
        })

        it('should call to overhead controller release', (done) => {
          const releaseRequest = sinon.stub().callsFake(originalReleaseRequest)
          overheadController.releaseRequest = releaseRequest
          agent
            .use(traces => {
              expect(traces[0][0].meta['_dd.iast.json']).to.include('"WEAK_HASH"')
              expect(releaseRequest).to.have.been.calledOnce
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

    beforeEach(() => {
      mockVulnerabilityReporter = {
        sendVulnerabilities: sinon.stub()
      }
      mockOverheadController = {
        acquireRequest: sinon.stub(),
        releaseRequest: sinon.stub(),
        initializeRequestContext: sinon.stub()
      }
      mockIast = proxyquire('../../../src/appsec/iast', {
        './vulnerability-reporter': mockVulnerabilityReporter,
        './overhead-controller': mockOverheadController
      })
    })

    afterEach(() => {
      sinon.restore()
      mockIast.disable()
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
        expect(mockVulnerabilityReporter.sendVulnerabilities).not.to.be.called
      })

      it('should not call send vulnerabilities with context but without iast context', () => {
        mockIast.onIncomingHttpRequestEnd({ req: {} })
        expect(mockVulnerabilityReporter.sendVulnerabilities).not.to.be.called
      })

      it('should not call releaseRequest without iast context', () => {
        mockIast.onIncomingHttpRequestEnd({ req: {} })
        expect(mockOverheadController.releaseRequest).not.to.be.called
      })
    })
  })
})
