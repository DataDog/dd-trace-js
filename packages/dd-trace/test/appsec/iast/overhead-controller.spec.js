const overheadController = require('../../../src/appsec/iast/overhead-controller')

describe('Overhead controller', () => {
  describe('Single shot operation', () => {
    const SINGLE_SHOT_OPERATION = overheadController.SINGLE_SHOT_OPERATIONS.REPORT_VULNERABILITY

    it.skip('should not allow with empty context', () => {
      expect(overheadController.hasQuotaSingleShot(SINGLE_SHOT_OPERATION, {})).to.be.false
    })

    it('should allow when available tokens', () => {
      const iastContext = {
        oce: {
          isRequestAnalyzed: true,
          tokens: {
            [SINGLE_SHOT_OPERATION.name]: 2
          }
        }
      }
      expect(overheadController.hasQuotaSingleShot(SINGLE_SHOT_OPERATION, iastContext)).to.be.true
      expect(iastContext).to.have.nested.property(`oce.tokens.${SINGLE_SHOT_OPERATION.name}`, 1)
    })

    it('should not allow when no available tokens', () => {
      const iastContext = {
        oce: {
          isRequestAnalyzed: true,
          tokens: {
            [SINGLE_SHOT_OPERATION.name]: 0
          }
        }
      }
      expect(overheadController.hasQuotaSingleShot(SINGLE_SHOT_OPERATION, iastContext)).to.be.false
      expect(iastContext).to.have.nested.property(`oce.tokens.${SINGLE_SHOT_OPERATION.name}`, 0)
    })

    it('should not allow when no request is not being analyzed', () => {
      const iastContext = {
        oce: {
          isRequestAnalyzed: false,
          tokens: {
            [SINGLE_SHOT_OPERATION.name]: 2
          }
        }
      }
      expect(overheadController.hasQuotaSingleShot(SINGLE_SHOT_OPERATION, iastContext)).to.be.false
      expect(iastContext).to.have.nested.property(`oce.tokens.${SINGLE_SHOT_OPERATION.name}`, 2)
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
          quotas.push(overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION, {}))
          expect(quotas[i].isAcquired()).to.be.true
        }
      }

      afterEach(() => {
        releaseAllQuotas()
      })

      it('should acquire quota when available tokens', () => {
        const quota = overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION, {})
        expect(quota.isAcquired()).to.be.true
        quota.release()
      })

      it('should flag request being analyzed when quota is acquired', () => {
        const iastContext = {}
        const quota = overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION, iastContext)
        expect(iastContext.oce.isRequestAnalyzed).to.be.true
        quota.release()
      })

      it('should not acquire quota when no available tokens', () => {
        spendAllAvailableTokens()
        quotas.push(overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION, {}))
        expect(quotas[quotas.length - 1].isAcquired()).to.be.false
      })

      it('should not flag request being analyzed when quota is not acquired', () => {
        const iastContext = {}
        spendAllAvailableTokens()
        const quota = overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION, iastContext)
        expect(iastContext.oce.isRequestAnalyzed).to.be.false
        quota.release()
      })

      it('should acquire quota when max concurrent requests has been reached and one of the acquired is released',
        () => {
          spendAllAvailableTokens()
          quotas[0].release()
          quotas.push(overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION, {}))
          expect(quotas[quotas.length - 1].isAcquired()).to.be.true
        })

      it('should not acquire quota when max concurrent requests has been reached and one of the denied is released',
        () => {
          spendAllAvailableTokens()
          quotas.push(overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION, {}))
          quotas[quotas.length - 1].release()
          quotas.push(overheadController.hasQuotaLongRunning(LONG_RUNNING_OPERATION, {}))
          expect(quotas[quotas.length - 1].isAcquired()).to.be.false
        })
    })
  })
})
