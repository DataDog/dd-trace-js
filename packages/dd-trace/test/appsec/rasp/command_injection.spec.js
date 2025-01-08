'use strict'

const proxyquire = require('proxyquire')
const addresses = require('../../../src/appsec/addresses')
const { childProcessExecutionTracingChannel } = require('../../../src/appsec/channels')

const { start } = childProcessExecutionTracingChannel

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
    it('should not analyze command_injection if rasp is disabled', () => {
      commandInjection.disable()
      const ctx = {
        file: 'cmd'
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      start.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze command_injection if no store', () => {
      const ctx = {
        file: 'cmd'
      }
      datadogCore.storage.getStore.returns(undefined)

      start.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze command_injection if no req', () => {
      const ctx = {
        file: 'cmd'
      }
      datadogCore.storage.getStore.returns({})

      start.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze command_injection if no file', () => {
      const ctx = {
        fileArgs: ['arg0']
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      start.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    describe('command_injection with shell', () => {
      it('should analyze command_injection without arguments', () => {
        const ctx = {
          file: 'cmd',
          shell: true
        }
        const req = {}
        datadogCore.storage.getStore.returns({ req })

        start.publish(ctx)

        const persistent = { [addresses.SHELL_COMMAND]: 'cmd' }
        sinon.assert.calledOnceWithExactly(
          waf.run, { persistent }, req, { type: 'command_injection', variant: 'shell' }
        )
      })

      it('should analyze command_injection with arguments', () => {
        const ctx = {
          file: 'cmd',
          fileArgs: ['arg0', 'arg1'],
          shell: true
        }
        const req = {}
        datadogCore.storage.getStore.returns({ req })

        start.publish(ctx)

        const persistent = { [addresses.SHELL_COMMAND]: ['cmd', 'arg0', 'arg1'] }
        sinon.assert.calledOnceWithExactly(
          waf.run, { persistent }, req, { type: 'command_injection', variant: 'shell' }
        )
      })

      it('should call handleResult', () => {
        const abortController = { abort: 'abort' }
        const ctx = { file: 'cmd', abortController, shell: true }
        const wafResult = { waf: 'waf' }
        const req = { req: 'req' }
        const res = { res: 'res' }
        waf.run.returns(wafResult)
        datadogCore.storage.getStore.returns({ req, res })

        start.publish(ctx)

        sinon.assert.calledOnceWithExactly(utils.handleResult, wafResult, req, res, abortController, config)
      })
    })

    describe('command_injection without shell', () => {
      it('should analyze command injection without arguments', () => {
        const ctx = {
          file: 'ls',
          shell: false
        }
        const req = {}
        datadogCore.storage.getStore.returns({ req })

        start.publish(ctx)

        const persistent = { [addresses.EXEC_COMMAND]: ['ls'] }
        sinon.assert.calledOnceWithExactly(
          waf.run, { persistent }, req, { type: 'command_injection', variant: 'exec' }
        )
      })

      it('should analyze command injection with arguments', () => {
        const ctx = {
          file: 'ls',
          fileArgs: ['-la', '/tmp'],
          shell: false
        }
        const req = {}
        datadogCore.storage.getStore.returns({ req })

        start.publish(ctx)

        const persistent = { [addresses.EXEC_COMMAND]: ['ls', '-la', '/tmp'] }
        sinon.assert.calledOnceWithExactly(
          waf.run, { persistent }, req, { type: 'command_injection', variant: 'exec' }
        )
      })

      it('should call handleResult', () => {
        const abortController = { abort: 'abort' }
        const ctx = { file: 'cmd', abortController, shell: false }
        const wafResult = { waf: 'waf' }
        const req = { req: 'req' }
        const res = { res: 'res' }
        waf.run.returns(wafResult)
        datadogCore.storage.getStore.returns({ req, res })

        start.publish(ctx)

        sinon.assert.calledOnceWithExactly(utils.handleResult, wafResult, req, res, abortController, config)
      })
    })
  })
})
