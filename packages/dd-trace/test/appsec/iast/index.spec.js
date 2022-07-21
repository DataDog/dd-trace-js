const proxyquire = require('proxyquire')
const { incomingHttpRequestEnd } = require('../../../src/appsec/gateway/channels')

describe('IAST Index', () => {
  let web
  let vulnerabilityReporter
  let IAST
  beforeEach(() => {
    web = {
      getContext: sinon.stub()
    }
    vulnerabilityReporter = {
      sendVulnerabilities: sinon.stub()
    }
    IAST = proxyquire('../../../src/appsec/iast', {
      '../../plugins/util/web': web,
      './vulnerability-reporter': vulnerabilityReporter
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
      const iastContext = { vulnerabilities: [] }
      const context = { span }
      context[IAST.IAST_CONTEXT_KEY] = iastContext
      web.getContext.returns(context)
      IAST.onIncomingHttpRequestEnd({ req: {} })
      expect(vulnerabilityReporter.sendVulnerabilities).to.be.calledOnceWith(iastContext, span)
    })
  })
})
