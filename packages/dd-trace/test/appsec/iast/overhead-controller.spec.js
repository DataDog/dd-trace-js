const overheadController = require('../../../src/appsec/iast/overhead-controller')

describe('Overhead controller', () => {
  const oceContextKey = overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY

  describe('Initialize OCE context', () => {
    it('should populate oce context', () => {
      const iastContext = {}
      overheadController.initializeRequestContext(iastContext)
      expect(iastContext).to.have.nested.property(overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY)
    })
  })

  describe('Single shot operation', () => {
    it('should not allow with no context', () => {
      expect(overheadController.hasQuotaSingleShot(overheadController.SINGLE_SHOT_OPERATIONS[0])).to.be.false
      expect(overheadController.hasQuotaSingleShot(overheadController.SINGLE_SHOT_OPERATIONS[0], null)).to.be.false
      expect(overheadController.hasQuotaSingleShot(overheadController.SINGLE_SHOT_OPERATIONS[0], {})).to.be.false
    })

    describe('Report vulnerability', () => {
      let iastContext

      const SINGLE_SHOT_OPERATION = overheadController.SINGLE_SHOT_OPERATIONS.REPORT_VULNERABILITY

      beforeEach(() => {
        iastContext = {}
        overheadController.initializeRequestContext(iastContext)
      })

      it('should populate initial context with available tokens', () => {
        expect(iastContext[oceContextKey])
          .to.have.nested.property(`tokens.${SINGLE_SHOT_OPERATION.name}`, SINGLE_SHOT_OPERATION.initialTokenBucketSize)
      })

      it('should allow when available tokens', () => {
        iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].isRequestAnalyzed = true
        iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].tokens[SINGLE_SHOT_OPERATION.name] = 2
        expect(overheadController.hasQuotaSingleShot(SINGLE_SHOT_OPERATION, iastContext)).to.be.true
        expect(iastContext[oceContextKey]).to.have.nested.property(`tokens.${SINGLE_SHOT_OPERATION.name}`, 1)
      })

      it('should not allow when no available tokens', () => {
        iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].isRequestAnalyzed = true
        iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].tokens[SINGLE_SHOT_OPERATION.name] = 0
        expect(overheadController.hasQuotaSingleShot(SINGLE_SHOT_OPERATION, iastContext)).to.be.false
        expect(iastContext[oceContextKey]).to.have.nested.property(`tokens.${SINGLE_SHOT_OPERATION.name}`, 0)
      })

      it('should not allow when no request is not being analyzed', () => {
        iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].isRequestAnalyzed = false
        iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].tokens[SINGLE_SHOT_OPERATION.name] = 2
        expect(overheadController.hasQuotaSingleShot(SINGLE_SHOT_OPERATION, iastContext)).to.be.false
        expect(iastContext[oceContextKey]).to.have.nested.property(`tokens.${SINGLE_SHOT_OPERATION.name}`, 2)
      })
    })
  })

  describe('Long running operation', () => {
    describe('Analyze request', () => {
      const LONG_RUNNING_OPERATION = overheadController.LONG_RUNNING_OPERATIONS.ANALYZE_REQUEST
      const quotas = []

      const releaseAllQuotas = () => {
        quotas.forEach(quota => quota.release())
        quotas.splice(0, quotas.length)
      }

      const spendAllAvailableTokens = () => {
        for (let i = quotas.length; i < LONG_RUNNING_OPERATION.initialTokenBucketSize; i++) {
          quotas.push(overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION))
          expect(quotas[i].isAcquired()).to.be.true
        }
      }

      afterEach(() => {
        releaseAllQuotas()
      })

      it('should acquire quota when available tokens', () => {
        const quota = overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION)
        expect(quota.isAcquired()).to.be.true
        quota.release()
      })

      it('should not acquire quota when no available tokens', () => {
        spendAllAvailableTokens()
        quotas.push(overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION))
        expect(quotas[quotas.length - 1].isAcquired()).to.be.false
      })

      it('should acquire quota when max concurrent requests has been reached and one of the acquired is released',
        () => {
          spendAllAvailableTokens()
          quotas[0].release()
          quotas.push(overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION))
          expect(quotas[quotas.length - 1].isAcquired()).to.be.true
        })

      it('should not acquire quota when max concurrent requests has been reached and one of the denied is released',
        () => {
          spendAllAvailableTokens()
          quotas.push(overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION))
          quotas[quotas.length - 1].release()
          quotas.push(overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION))
          expect(quotas[quotas.length - 1].isAcquired()).to.be.false
        })
    })
  })
})
