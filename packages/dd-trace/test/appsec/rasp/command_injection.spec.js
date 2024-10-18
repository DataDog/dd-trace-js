'use strict'

const proxyquire = require('proxyquire')
const { childProcessExecutionStart } = require('../../../src/appsec/channels')
const addresses = require('../../../src/appsec/addresses')

describe('RASP - command_injection.js', () => {
  let waf, datadogCore, commandInjection, utils, config

  beforeEach(() => {
    datadogCore = {
      storage: {
        getStore: sinon.stub()
      }
    }

    waf = {
      run: sinon.stub()
    }

    utils = {
      handleResult: sinon.stub()
    }

    commandInjection = proxyquire('../../../src/appsec/rasp/command_injection', {
      '../../../../datadog-core': datadogCore,
      '../waf': waf,
      './utils': utils
    })

    config = {
      appsec: {
        stackTrace: {
          enabled: true,
          maxStackTraces: 2,
          maxDepth: 42
        }
      }
    }

    commandInjection.enable(config)
  })

  afterEach(() => {
    sinon.restore()
    commandInjection.disable()
  })

  describe('analyzeCommandInjection', () => {
    it('should analyze command_injection without arguments', () => {
      const ctx = {
        file: 'cmd'
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      childProcessExecutionStart.publish(ctx)

      const persistent = { [addresses.SHELL_COMMAND]: 'cmd' }
      sinon.assert.calledOnceWithExactly(waf.run, { persistent }, req, 'command_injection')
    })

    it('should analyze command_injection with arguments', () => {
      const ctx = {
        file: 'cmd',
        fileArgs: ['arg0', 'arg1']
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      childProcessExecutionStart.publish(ctx)

      const persistent = { [addresses.SHELL_COMMAND]: ['cmd', 'arg0', 'arg1'] }
      sinon.assert.calledOnceWithExactly(waf.run, { persistent }, req, 'command_injection')
    })

    it('should not analyze command_injection if rasp is disabled', () => {
      commandInjection.disable()
      const ctx = {
        file: 'cmd'
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      childProcessExecutionStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze command_injection if no store', () => {
      const ctx = {
        file: 'cmd'
      }
      datadogCore.storage.getStore.returns(undefined)

      childProcessExecutionStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze command_injection if no req', () => {
      const ctx = {
        file: 'cmd'
      }
      datadogCore.storage.getStore.returns({})

      childProcessExecutionStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze command_injection if no file', () => {
      const ctx = {
        fileArgs: ['arg0']
      }
      datadogCore.storage.getStore.returns({})

      childProcessExecutionStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should call handleResult', () => {
      const abortController = { abort: 'abort' }
      const ctx = { file: 'cmd', abortController }
      const wafResult = { waf: 'waf' }
      const req = { req: 'req'}
      const res = { res: 'res' }
      waf.run.returns(wafResult)
      datadogCore.storage.getStore.returns({ req, res })

      childProcessExecutionStart.publish(ctx)

      sinon.assert.calledOnceWithExactly(utils.handleResult, wafResult, req, res, abortController, config)
    })
  })
})
