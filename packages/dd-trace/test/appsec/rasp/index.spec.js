'use strict'

const proxyquire = require('proxyquire')
const { handleUncaughtExceptionMonitor } = require('../../../src/appsec/rasp')

describe('RASP', () => {
  let waf, rasp, datadogCore, stackTrace, web

  beforeEach(() => {
    datadogCore = {
      storage: {
        getStore: sinon.stub()
      }
    }
    waf = {
      run: sinon.stub()
    }

    stackTrace = {
      reportStackTrace: sinon.stub()
    }

    web = {
      root: sinon.stub()
    }

    rasp = proxyquire('../../../src/appsec/rasp', {
      '../../../../datadog-core': datadogCore,
      '../waf': waf,
      '../stack_trace': stackTrace,
      './../../plugins/util/web': web
    })

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
