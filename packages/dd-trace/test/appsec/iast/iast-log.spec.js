const { expect } = require('chai')
const proxyquire = require('proxyquire')

describe('IAST log', () => {
  let iastLog
  let telemetryLog
  let log

  beforeEach(() => {
    log = {
      debug: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub()
    }

    telemetryLog = {
      hasSubscribers: true,
      publish: sinon.stub()
    }

    iastLog = proxyquire('../../../src/appsec/iast/iast-log', {
      'dc-polyfill': {
        channel: () => telemetryLog
      },
      '../../log': log
    })
  })

  afterEach(() => {
    sinon.reset()
  })

  describe('debug', () => {
    it('should call log.debug', () => {
      iastLog.debug('debug')

      expect(log.debug).to.be.calledOnceWith('debug')
    })

    it('should call log.debug and publish msg via telemetry', () => {
      iastLog.debugAndPublish('debug')

      expect(log.debug).to.be.calledOnceWith('debug')
      expect(telemetryLog.publish).to.be.calledOnceWith({ message: 'debug', level: 'DEBUG' })
    })
  })

  describe('warn', () => {
    it('should call log.warn', () => {
      iastLog.warn('warn')

      expect(log.warn).to.be.calledOnceWith('warn')
    })

    it('should call log.warn and publish msg via telemetry', () => {
      iastLog.warnAndPublish('warn')

      expect(log.warn).to.be.calledOnceWith('warn')
      expect(telemetryLog.publish).to.be.calledOnceWith({ message: 'warn', level: 'WARN' })
    })

    it('should chain multiple warn calls', () => {
      iastLog.warn('warn').warnAndPublish('warnAndPublish').warn('warn2')

      expect(log.warn).to.be.calledThrice
      expect(log.warn.getCall(0).args[0]).to.be.eq('warn')
      expect(log.warn.getCall(1).args[0]).to.be.eq('warnAndPublish')
      expect(log.warn.getCall(2).args[0]).to.be.eq('warn2')
      expect(telemetryLog.publish).to.be.calledOnceWith({ message: 'warnAndPublish', level: 'WARN' })
    })
  })

  describe('error', () => {
    it('should call log.error', () => {
      iastLog.error('error')

      expect(log.error).to.be.calledOnceWith('error')
    })

    it('should call log.error and publish msg via telemetry', () => {
      iastLog.errorAndPublish('error')

      expect(log.error).to.be.calledOnceWith('error')
      expect(telemetryLog.publish).to.be.calledOnceWith({ message: 'error', level: 'ERROR' })
    })

    it('should chain multiple error calls', () => {
      iastLog.error('error').errorAndPublish('errorAndPublish').error('error2')

      expect(log.error).to.be.calledThrice
      expect(log.error.getCall(0).args[0]).to.be.eq('error')
      expect(log.error.getCall(1).args[0]).to.be.eq('errorAndPublish')
      expect(log.error.getCall(2).args[0]).to.be.eq('error2')
      expect(telemetryLog.publish).to.be.calledOnceWith({ message: 'errorAndPublish', level: 'ERROR' })
    })
  })
})
