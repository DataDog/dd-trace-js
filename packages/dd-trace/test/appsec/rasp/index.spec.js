'use strict'

const rasp = require('../../../src/appsec/rasp')
const { handleUncaughtExceptionMonitor } = require('../../../src/appsec/rasp')

describe('RASP', () => {
  beforeEach(() => {
    const config = {
      appsec: {
        stackTrace: {
          enabled: true,
          maxStackTraces: 2,
          maxDepth: 42
        }
      }
    }

    rasp.enable(config)
  })

  afterEach(() => {
    sinon.restore()
    rasp.disable()
  })

  describe('handleUncaughtExceptionMonitor', () => {
    it('should not break with infinite loop of cause', () => {
      const err = new Error()
      err.cause = err

      handleUncaughtExceptionMonitor(err)
    })
  })
})
