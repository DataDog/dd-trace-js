const proxyquire = require('proxyquire')
const { incomingHttpRequestEnd } = require('../../../src/appsec/gateway/channels')
const Config = require('../../../src/config')

describe('IAST Index', () => {
  let web
  let vulnerabilityReporter
  let IAST
  let datadogCore
  let overheadController
  let config
  beforeEach(() => {
    config = new Config({
      experimental: {
        iast: true
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
    overheadController = {
      acquireRequest: sinon.stub(),
      releaseRequest: sinon.stub(),
      initializeRequestContext: sinon.stub(),
      startGlobalContextResetScheduler: sinon.stub(),
      stopGlobalContextResetScheduler: sinon.stub()
    }
    IAST = proxyquire('../../../src/appsec/iast', {
      '../../plugins/util/web': web,
      './vulnerability-reporter': vulnerabilityReporter,
      '../../../../datadog-core': datadogCore,
      './overhead-controller': overheadController
    })
    sinon.stub(incomingHttpRequestEnd, 'subscribe')
  })

  afterEach(() => {
    sinon.restore()
    IAST.disable()
  })

  describe('enable', () => {
    it('should subscribe', () => {
      IAST.enable(config)
      expect(incomingHttpRequestEnd.subscribe).to.have.been.calledOnceWithExactly(IAST.onIncomingHttpRequestEnd)
    })
    it('should start OCE global context', () => {
      IAST.enable(config)
      expect(overheadController.startGlobalContextResetScheduler).to.have.been.calledOnce
    })
  })

  describe('disable', () => {
    it('should unsubscribe', () => {
      incomingHttpRequestEnd.subscribe.restore()
      IAST.enable(config)
      sinon.spy(incomingHttpRequestEnd, 'unsubscribe')
      IAST.disable()
      expect(incomingHttpRequestEnd.unsubscribe)
        .to.have.been.calledOnceWithExactly(IAST.onIncomingHttpRequestEnd)
    })

    it('should stop OCE global context', () => {
      IAST.disable()
      expect(overheadController.stopGlobalContextResetScheduler).to.have.been.calledOnce
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
      expect(store[IAST.IAST_CONTEXT_KEY]).not.null
      expect(store[IAST.IAST_CONTEXT_KEY].req).equals(data.req)
      expect(store[IAST.IAST_CONTEXT_KEY].rootSpan).equals(topContext.span)
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
      const iastContext = { vulnerabilities: [], rootSpan: span }
      const store = { span }
      store[IAST.IAST_CONTEXT_KEY] = iastContext
      datadogCore.storage.getStore.returns(store)
      IAST.onIncomingHttpRequestEnd({ req: {} })
      expect(vulnerabilityReporter.sendVulnerabilities).to.be.calledOnceWith(iastContext, span)
    })

    it('should call releaseRequest with context with iast context', () => {
      const span = { key: 'val' }
      const iastContext = { vulnerabilities: [], rootSpan: span }
      const store = { span }
      store[IAST.IAST_CONTEXT_KEY] = iastContext
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
})
