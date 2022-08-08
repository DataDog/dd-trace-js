const overheadController = require('../../../src/appsec/iast/overhead-controller')
const DatadogSpanContext = require('../../../src/opentracing/span_context')

describe('Overhead controller', () => {
  const oceContextKey = overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY

  beforeEach(() => {
    overheadController._resetGlobalContext()
  })

  describe('Initialize OCE context', () => {
    it('should populate oce context', () => {
      const iastContext = {}
      overheadController.initializeRequestContext(iastContext)
      expect(iastContext).to.have.nested.property(overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY)
    })
  })

  describe('Analyze request', () => {
    it('should allow requests which span id is divisible by 3', () => {
      const rootSpan = {
        context: sinon.stub().returns(new DatadogSpanContext({
          spanId: 3
        }))
      }

      const reserved = overheadController.acquireRequest(rootSpan)
      expect(reserved).to.be.true
    })
  })

  it('should not allow requests which span id is not divisible by 3', () => {
    const rootSpan = {
      context: sinon.stub().returns(new DatadogSpanContext({
        spanId: 2
      }))
    }

    const reserved = overheadController.acquireRequest(rootSpan)
    expect(reserved).to.be.false
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
            .to.have.nested.property(`tokens.${OPERATION.name}`, OPERATION.initialTokenBucketSize)
        })

        it('should allow when available tokens', () => {
          iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].isRequestAnalyzed = true
          iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].tokens[OPERATION.name] = 2
          expect(overheadController.hasQuota(OPERATION, iastContext)).to.be.true
          expect(iastContext[oceContextKey]).to.have.nested.property(`tokens.${OPERATION.name}`, 1)
        })

        it('should not allow when no available tokens', () => {
          iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].isRequestAnalyzed = true
          iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].tokens[OPERATION.name] = 0
          expect(overheadController.hasQuota(OPERATION, iastContext)).to.be.false
          expect(iastContext[oceContextKey]).to.have.nested.property(`tokens.${OPERATION.name}`, 0)
        })
      })

      describe('out of request', () => {
        it('should reject the operation once all tokens has been spent', () => {
          for (let i = 0, l = OPERATION.initialTokenBucketSize; i < l; i++) {
            expect(overheadController.hasQuota(OPERATION, {})).to.be.true
          }
          expect(overheadController.hasQuota(OPERATION, {})).to.be.false
        })
      })
    })
  })
})
