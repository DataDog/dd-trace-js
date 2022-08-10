const overheadController = require('../../../src/appsec/iast/overhead-controller')
const DatadogSpanContext = require('../../../src/opentracing/span_context')
const Config = require('../../../src/config')
const id = require('../../../src/id')
describe('Overhead controller', () => {
  const oceContextKey = overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY

  beforeEach(() => {
    const config = new Config({
      experimental: {
        iast: true
      }
    })
    overheadController.configureOCE(config.iast.oce)
    overheadController._resetGlobalContext()
  })

  describe('Initialize OCE context', () => {
    describe('Request context', () => {
      it('should not fail when no context is provided', () => {
        overheadController.initializeRequestContext()
      })

      it('should populate request context', () => {
        const iastContext = {}
        overheadController.initializeRequestContext(iastContext)
        expect(iastContext).to.have.nested.property(overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY)
      })
    })
  })

  describe('Analyze request', () => {
    it('should allow requests which span id ends with a smaller number than default 30', () => {
      const rootSpan = {
        context: sinon.stub().returns(new DatadogSpanContext({
          spanId: id('6004358438913972427', 10)
        }))
      }

      const reserved = overheadController.acquireRequest(rootSpan)
      expect(reserved).to.be.true
    })

    it('should allow requests which span id ends with a default 30', () => {
      const rootSpan = {
        context: sinon.stub().returns(new DatadogSpanContext({
          spanId: id('6004358438913972430', 10)
        }))
      }

      const reserved = overheadController.acquireRequest(rootSpan)
      expect(reserved).to.be.true
    })

    it('should not allow requests which span id ends with a bigger number than default 30', () => {
      const rootSpan = {
        context: sinon.stub().returns(new DatadogSpanContext({
          spanId: id('6004358438913972431', 10)
        }))
      }

      const reserved = overheadController.acquireRequest(rootSpan)
      expect(reserved).to.be.false
    })

    it('should allow a maximum of 2 request at same time', () => {
      const rootSpan1 = {
        context: sinon.stub().returns(new DatadogSpanContext({
          spanId: id('6004358438913972418', 10)
        }))
      }
      const rootSpan2 = {
        context: sinon.stub().returns(new DatadogSpanContext({
          spanId: id('6004358438913972417', 10)
        }))
      }
      const rootSpan3 = {
        context: sinon.stub().returns(new DatadogSpanContext({
          spanId: id('6004358438913972416', 10)
        }))
      }

      const reserved1 = overheadController.acquireRequest(rootSpan1)
      const reserved2 = overheadController.acquireRequest(rootSpan2)
      const reserved3 = overheadController.acquireRequest(rootSpan3)
      expect(reserved1).to.be.true
      expect(reserved2).to.be.true
      expect(reserved3).to.be.false
    })

    it('should release a request', () => {
      const rootSpan1 = {
        context: sinon.stub().returns(new DatadogSpanContext({
          spanId: id('6004358438913972418', 10)
        }))
      }
      const rootSpan2 = {
        context: sinon.stub().returns(new DatadogSpanContext({
          spanId: id('6004358438913972417', 10)
        }))
      }
      const rootSpan3 = {
        context: sinon.stub().returns(new DatadogSpanContext({
          spanId: id('6004358438913972416', 10)
        }))
      }
      const rootSpan4 = {
        context: sinon.stub().returns(new DatadogSpanContext({
          spanId: id('6004358438913972429', 10)
        }))
      }

      const reserved1 = overheadController.acquireRequest(rootSpan1)
      const reserved2 = overheadController.acquireRequest(rootSpan2)
      const reserved3 = overheadController.acquireRequest(rootSpan3)
      overheadController.releaseRequest()
      const reserved4 = overheadController.acquireRequest(rootSpan4)
      expect(reserved1).to.be.true
      expect(reserved2).to.be.true
      expect(reserved3).to.be.false
      expect(reserved4).to.be.true
    })
  })

  describe('Operations', () => {
    describe('Report vulnerability', () => {
      let iastContext
      const OPERATION = overheadController.OPERATIONS.REPORT_VULNERABILITY

      it('should not fail with unexpected data', () => {
        overheadController.hasQuota(OPERATION)
        overheadController.hasQuota(OPERATION, null)
        overheadController.hasQuota(OPERATION, {})
      })

      describe('within request', () => {
        beforeEach(() => {
          iastContext = {}
          overheadController.initializeRequestContext(iastContext)
        })

        it('should populate initial context with available tokens', () => {
          expect(iastContext[oceContextKey])
            .to.have.nested.property(`tokens.${OPERATION.name}`, OPERATION.initialTokenBucketSize())
        })

        it('should allow when available tokens', () => {
          iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].tokens[OPERATION.name] = 2
          expect(overheadController.hasQuota(OPERATION, iastContext)).to.be.true
          expect(iastContext[oceContextKey]).to.have.nested.property(`tokens.${OPERATION.name}`, 1)
        })

        it('should not allow when no available tokens', () => {
          iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].tokens[OPERATION.name] = 0
          expect(overheadController.hasQuota(OPERATION, iastContext)).to.be.false
          expect(iastContext[oceContextKey]).to.have.nested.property(`tokens.${OPERATION.name}`, 0)
        })
      })

      describe('out of request', () => {
        it('should reject the operation once all tokens has been spent', () => {
          for (let i = 0, l = OPERATION.initialTokenBucketSize(); i < l; i++) {
            expect(overheadController.hasQuota(OPERATION, {})).to.be.true
          }
          expect(overheadController.hasQuota(OPERATION, {})).to.be.false
        })
      })
    })
  })
})
