const { match } = require('sinon')
const proxyquire = require('proxyquire')

describe('telemetry logs', () => {
  let defaultConfig, application, host
  let telemetry

  beforeEach(() => {
    application = {}
    host = {}

    defaultConfig = {
      telemetry: {
        enabled: true,
        logCollection: true,
        debug: false
      }
    }

    telemetry = {
      createAppObject: sinon.stub().returns(application),
      createHostObject: sinon.stub().returns(host)
    }
  })

  describe('start', () => {
    it('should be enabled if telemetry.enabled = true && telemetry.logCollection = true', () => {
      const logs = proxyquire('../../../../../src/appsec/iast/telemetry/log', {
        '../../../../telemetry': telemetry
      })
      logs.start(defaultConfig)

      expect(telemetry.createAppObject).to.be.calledOnceWith(defaultConfig)
      expect(telemetry.createHostObject).to.be.calledOnce
    })

    it('should not be enabled if telemetry.enabled = false && telemetry.logCollection = true', () => {
      const logs = proxyquire('../../../../../src/appsec/iast/telemetry/log', {
        '../../../../telemetry': telemetry
      })

      defaultConfig.telemetry.enabled = false
      logs.start(defaultConfig)

      expect(telemetry.createAppObject).to.not.be.called
      expect(telemetry.createHostObject).to.not.be.called
    })

    it('should be disabled if logCollection = false', () => {
      const logs = proxyquire('../../../../../src/appsec/iast/telemetry/log', {
        '../../../../telemetry': telemetry
      })
      defaultConfig.telemetry.logCollection = false
      logs.start(defaultConfig)

      expect(telemetry.createAppObject).to.not.be.called
      expect(telemetry.createHostObject).to.not.be.called
    })

    it('should call sendData periodically', () => {
      const clock = sinon.useFakeTimers()
      const sendData = sinon.stub()

      let logCollectorCalled = 0
      const logs = proxyquire('../../../../../src/appsec/iast/telemetry/log', {
        '../../../../telemetry/send-data': { sendData },
        '../../../../telemetry': telemetry,
        './log-collector': {
          drain: () => {
            logCollectorCalled++
            return { message: 'Error 1', level: 'ERROR' }
          }
        }
      })

      defaultConfig.telemetry.heartbeatInterval = 60000
      logs.start(defaultConfig)

      clock.tick(60000)
      clock.tick(60000)

      expect(logCollectorCalled).to.be.eq(2)
      expect(sendData).to.have.been.calledTwice
      expect(sendData).to.have.been.calledWith(defaultConfig,
        application,
        host,
        'logs'
      )

      clock.restore()
    })
  })

  describe('stop', () => {
    it('should clear interval configured listeners', () => {
      const clock = sinon.useFakeTimers()
      const sendData = sinon.stub()

      let logCollectorCalled = 0
      const logs = proxyquire('../../../../../src/appsec/iast/telemetry/log', {
        '../../../../telemetry/send-data': { sendData },
        '../../../../telemetry': telemetry,
        './log-collector': {
          drain: () => {
            logCollectorCalled++
            return { message: 'Error 1', level: 'ERROR' }
          }
        }
      })

      defaultConfig.telemetry.heartbeatInterval = 60000
      logs.start(defaultConfig)

      clock.tick(60000)

      expect(logCollectorCalled).to.be.eq(1)

      // stop clears the interval and logCollector is no longer called
      logs.stop()

      clock.tick(60000)
      clock.tick(60000)
      clock.tick(60000)
      clock.tick(60000)

      expect(logCollectorCalled).to.be.eq(1)

      clock.restore()
    })
  })

  describe('sendData', () => {
    it('should be not called with DEBUG level', () => {
      const logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../../../src/appsec/iast/telemetry/log', {
        './log-collector': {
          add: logCollectorAdd
        }
      })
      logs.start(defaultConfig)

      logs.publish({ message: 'message', level: 'DEBUG' })

      expect(logCollectorAdd).to.not.be.called
    })

    it('should be called with DEBUG level if DEBUG level is enabled', () => {
      const logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../../../src/appsec/iast/telemetry/log', {
        './log-collector': {
          add: logCollectorAdd
        }
      })
      logs.start(defaultConfig, true)

      logs.publish({ message: 'message', level: 'DEBUG' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'DEBUG' }))
    })

    it('should be called with WARN level', () => {
      const logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../../../src/appsec/iast/telemetry/log', {
        './log-collector': {
          add: logCollectorAdd
        }
      })
      logs.start(defaultConfig)

      logs.publish({ message: 'message', level: 'WARN' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'WARN' }))
    })

    it('should be called with ERROR level', () => {
      const logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../../../src/appsec/iast/telemetry/log', {
        './log-collector': {
          add: logCollectorAdd
        }
      })
      logs.start(defaultConfig)

      logs.publish({ message: 'message', level: 'ERROR' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'ERROR' }))
    })

    it('should be called with ERROR level and stack_trace', () => {
      const logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../../../src/appsec/iast/telemetry/log', {
        './log-collector': {
          add: logCollectorAdd
        }
      })
      logs.start(defaultConfig)

      const error = new Error('message')
      const stack = error.stack
      logs.publish({ message: error.message, stack_trace: stack, level: 'ERROR' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'ERROR', stack_trace: stack }))
    })
  })
})
