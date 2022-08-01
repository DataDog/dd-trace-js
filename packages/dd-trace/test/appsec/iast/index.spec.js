const proxyquire = require('proxyquire')
const { incomingHttpRequestEnd } = require('../../../src/appsec/gateway/channels')
const { Quota } = require('../../../src/appsec/iast/overhead-controller')

describe('IAST Index', () => {
  let web
  let vulnerabilityReporter
  let IAST
  let datadogCore
  let overheadController
  beforeEach(() => {
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
      hasQuotaLongRunning: sinon.stub(),
      LONG_RUNNING_OPERATIONS: {
        ANALYZE_REQUEST: {}
      }
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
      IAST.enable()
      expect(incomingHttpRequestEnd.subscribe).to.have.been.calledOnceWithExactly(IAST.onIncomingHttpRequestEnd)
    })
  })

  describe('disable', () => {
    it('should unsubscribe', () => {
      incomingHttpRequestEnd.subscribe.restore()
      IAST.enable()
      sinon.spy(incomingHttpRequestEnd, 'unsubscribe')
      IAST.disable()
      expect(incomingHttpRequestEnd.unsubscribe)
        .to.have.been.calledOnceWithExactly(IAST.onIncomingHttpRequestEnd)
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
      overheadController.hasQuotaLongRunning.returns(new Quota(true, () => {}))
      IAST.onIncomingHttpRequestStart({ req: {} })
      expect(web.getContext).to.be.calledOnce
    })

    it('should not fail with unexpected store', () => {
      web.getContext.returns({})
      datadogCore.storage.getStore.returns(null)
      overheadController.hasQuotaLongRunning.returns(new Quota(true, () => {}))
      IAST.onIncomingHttpRequestStart({ req: {} })
      expect(datadogCore.storage.getStore).to.be.calledOnce
    })

    it('Adds IAST context to store', () => {
      const store = {}
      const topContext = { span: {} }
      const data = { req: {} }
      datadogCore.storage.getStore.returns(store)
      web.getContext.returns(topContext)
      overheadController.hasQuotaLongRunning.returns(new Quota(true, () => {}))
      IAST.onIncomingHttpRequestStart(data)
      expect(store[IAST.IAST_CONTEXT_KEY]).not.null
      expect(store[IAST.IAST_CONTEXT_KEY].req).equals(data.req)
      expect(store[IAST.IAST_CONTEXT_KEY].rootSpan).equals(topContext.span)
      expect(store[IAST.IAST_CONTEXT_KEY].analyzeRequestQuota).not.undefined
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

    it('should release quota for analyze request with iast context', () => {
      const _quotaRelease = sinon.stub()
      const span = { key: 'val' }
      const iastContext = { rootSpan: span, analyzeRequestQuota: new Quota(true, _quotaRelease) }
      const store = { span }
      store[IAST.IAST_CONTEXT_KEY] = iastContext
      datadogCore.storage.getStore.returns(store)
      IAST.onIncomingHttpRequestEnd({ req: {} })
      expect(_quotaRelease).to.be.calledOnce
    })
  })
})
