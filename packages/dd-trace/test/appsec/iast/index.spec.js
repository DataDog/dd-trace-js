const proxyquire = require('proxyquire')
const Config = require('../../../src/config')
const dc = require('diagnostics_channel')

const requestStart = dc.channel('dd-trace:incomingHttpRequestStart')
const requestFinish = dc.channel('dd-trace:incomingHttpRequestEnd')
const requestClose = dc.channel('apm:http:server:request:close')
describe('IAST Index', () => {
  let web
  let vulnerabilityReporter
  let IAST
  let iastContext
  let datadogCore
  let analyzers
  let overheadController
  let config
  beforeEach(() => {
    config = new Config({
      experimental: {
        iast: {
          enabled: true,
          oce: {
            requestSampling: 100,
            maxConcurrentRequest: 50
          }
        }
      }
    })
    web = {
      getContext: sinon.stub()
    }
    vulnerabilityReporter = {
      sendVulnerabilities: sinon.stub()
    }
    datadogCore = {
      storage: {
        getStore: sinon.stub()
      }
    }
    analyzers = {
      enableAllAnalyzers: sinon.stub(),
      disableAllAnalyzers: sinon.stub()
    }
    overheadController = {
      acquireRequest: sinon.stub(),
      releaseRequest: sinon.stub(),
      initializeRequestContext: sinon.stub()
    }
    iastContext = {
      getIastContext: sinon.stub(),
      saveIastContext: sinon.stub(),
      cleanIastContext: sinon.stub()
    }
    IAST = proxyquire('../../../src/appsec/iast', {
      '../../plugins/util/web': web,
      './vulnerability-reporter': vulnerabilityReporter,
      '../../../../datadog-core': datadogCore,
      './analyzers': analyzers,
      './overhead-controller': overheadController,
      './iast-context': iastContext
    })
  })

  afterEach(() => {
    sinon.restore()
    IAST.disable()
  })

  describe('enable', () => {
    it('should subscribe', () => {
      expect(requestStart.hasSubscribers).to.be.false
      expect(requestFinish.hasSubscribers).to.be.false
      expect(requestClose.hasSubscribers).to.be.false
      IAST.enable(config)
      expect(requestStart.hasSubscribers).to.be.true
      expect(requestFinish.hasSubscribers).to.be.true
      expect(requestClose.hasSubscribers).to.be.true
    })
    it('should enable all analyzers', () => {
      IAST.enable(config)
      expect(analyzers.enableAllAnalyzers).to.have.been.calledOnce
    })
  })

  describe('disable', () => {
    it('should unsubscribe', () => {
      IAST.enable(config)
      IAST.disable()
      expect(requestStart.hasSubscribers).to.be.false
      expect(requestFinish.hasSubscribers).to.be.false
      expect(requestClose.hasSubscribers).to.be.false
    })
    it('should disable all analyzers', () => {
      IAST.disable()
      expect(analyzers.disableAllAnalyzers).to.have.been.calledOnce
    })
  })

  describe('onIncomingHttpRequestStart', () => {
    it('should not fail with unexpected data', () => {
      IAST.onIncomingHttpRequestStart()
      IAST.onIncomingHttpRequestStart(null)
      IAST.onIncomingHttpRequestStart({})
    })

    it('should not fail with unexpected context', () => {
      datadogCore.storage.getStore.returns({})
      web.getContext.returns(null)
      overheadController.acquireRequest.returns(true)
      IAST.onIncomingHttpRequestStart({ req: {} })
      expect(web.getContext).to.be.calledOnce
    })

    it('should not fail with unexpected store', () => {
      web.getContext.returns({})
      datadogCore.storage.getStore.returns(null)
      overheadController.acquireRequest.returns(true)
      IAST.onIncomingHttpRequestStart({ req: {} })
      expect(datadogCore.storage.getStore).to.be.calledOnce
    })

    it('should add IAST context to store', () => {
      const store = {}
      const topContext = { span: {} }
      const data = { req: {} }
      datadogCore.storage.getStore.returns(store)
      web.getContext.returns(topContext)
      overheadController.acquireRequest.returns(true)
      IAST.onIncomingHttpRequestStart(data)
      expect(iastContext.saveIastContext)
        .to.have.been.calledOnceWith(store, topContext, { req: data.req, rootSpan: topContext.span })
    })

    it('should initialize OCE context when analyze request is acquired', () => {
      const store = {}
      const topContext = { span: {} }
      const data = { req: {} }
      datadogCore.storage.getStore.returns(store)
      web.getContext.returns(topContext)
      overheadController.acquireRequest.returns(true)
      IAST.onIncomingHttpRequestStart(data)
      expect(overheadController.initializeRequestContext).to.be.calledOnce
    })
  })

  describe('onIncomingHttpRequestEnd', () => {
    it('should not fail without unexpected data', () => {
      IAST.onIncomingHttpRequestEnd()
      IAST.onIncomingHttpRequestEnd(null)
      IAST.onIncomingHttpRequestEnd({})
    })

    it('should not call send vulnerabilities without context', () => {
      web.getContext.returns(null)
      IAST.onIncomingHttpRequestEnd({ req: {} })
      expect(vulnerabilityReporter.sendVulnerabilities).not.to.be.called
    })

    it('should not call send vulnerabilities with empty context', () => {
      web.getContext.returns({})
      IAST.onIncomingHttpRequestEnd({ req: {} })
      expect(vulnerabilityReporter.sendVulnerabilities).not.to.be.called
    })

    it('should not call send vulnerabilities with context but without iast context', () => {
      web.getContext.returns({ span: {} })
      IAST.onIncomingHttpRequestEnd({ req: {} })
      expect(vulnerabilityReporter.sendVulnerabilities).not.to.be.called
    })

    it('should call send vulnerabilities with context with span and iast context', () => {
      const span = { key: 'val' }
      const _iastContext = { vulnerabilities: [], rootSpan: span }
      const store = { span }
      datadogCore.storage.getStore.returns(store)
      iastContext.getIastContext.returns(_iastContext)
      IAST.onIncomingHttpRequestEnd({ req: {} })
      expect(vulnerabilityReporter.sendVulnerabilities).to.be.calledOnceWith(_iastContext, span)
    })

    it('should call releaseRequest with context with iast context', () => {
      const span = { key: 'val' }
      const _iastContext = { vulnerabilities: [], rootSpan: span }
      const store = { span }
      iastContext.getIastContext.returns(_iastContext)
      datadogCore.storage.getStore.returns(store)
      IAST.onIncomingHttpRequestEnd({ req: {} })
      expect(overheadController.releaseRequest).to.be.calledOnce
    })

    it('should not call releaseRequest without iast context', () => {
      const store = {}
      datadogCore.storage.getStore.returns(store)
      IAST.onIncomingHttpRequestEnd({ req: {} })
      expect(overheadController.releaseRequest).not.to.be.called
    })
  })

  describe('cleanIastContext', () => {
    it('should clean the iast context', () => {
      const store = {}
      const req = {}
      const topContext = { span: {} }
      IAST.enable(config)
      web.getContext.returns(topContext)
      overheadController.acquireRequest.returns(true)
      datadogCore.storage.getStore.returns(store)
      iastContext.cleanIastContext.returns(true)
      requestStart.publish({ req })
      expect(iastContext.saveIastContext)
        .to.have.been.calledOnceWith(store, topContext, { req: req, rootSpan: topContext.span })
      datadogCore.storage.getStore.returns({})
      requestClose.publish({ req })
      expect(iastContext.cleanIastContext)
        .to.have.been.calledOnceWith(store, topContext)
      expect(overheadController.releaseRequest).to.have.been.calledOnce
    })
  })
})
