const { expect } = require('chai')
const proxyquire = require('proxyquire')
const { calculateDDBasePath } = require('../../../src/util')

const ddBasePath = calculateDDBasePath(__dirname)
const EOL = '\n'

describe('IAST log', () => {
  const telemetryDebugConfig = {
    config: {
      logCollection: true,
      debug: true
    }
  }

  const telemetryDefaultConfig = {
    config: {
      logCollection: true,
      debug: false
    }
  }

  let iastLog
  let logCollector
  let log

  beforeEach(() => {
    log = {
      debug: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub()
    }
    logCollector = proxyquire('../../../src/appsec/telemetry/log-collector', {
      '../../log': log
    })
    logCollector.init(telemetryDefaultConfig.config)

    sinon.stub(logCollector, 'add')

    iastLog = proxyquire('../../../src/appsec/iast/iast-log', {
      '../telemetry/log-collector': logCollector,
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

    it('should call log.debug and not publish msg via telemetry', () => {
      iastLog.debugAndPublish('debug')

      expect(log.debug).to.be.calledOnceWith('debug')
      expect(logCollector.add).to.not.be.called
    })

    it('should call log.debug and publish msg via telemetry', () => {
      logCollector.init(telemetryDebugConfig.config)

      iastLog.debugAndPublish('debug')

      expect(log.debug).to.be.calledOnceWith('debug')
      expect(logCollector.add).to.be.calledOnceWith({ message: 'debug', level: 'DEBUG' })
    })

    it('should chain multiple debug calls', () => {
      logCollector.init(telemetryDebugConfig.config)

      iastLog.debug('debug').debugAndPublish('debugAndPublish').debug('debug2')

      expect(log.debug).to.be.calledThrice
      expect(log.debug.firstCall.args[0]).to.be.eq('debug')
      expect(log.debug.getCall(1).args[0]).to.be.eq('debugAndPublish')
      expect(log.debug.getCall(2).args[0]).to.be.eq('debug2')
      expect(logCollector.add).to.be.calledOnceWith({ message: 'debugAndPublish', level: 'DEBUG' })
    })

    it('should chain multiple debug calls', () => {
      logCollector.init(telemetryDebugConfig.config)

      iastLog.debug('debug')

      logCollector.init()

      iastLog.debugAndPublish('debugAndPublish').debug('debug2')
    })
  })

  describe('info', () => {
    it('should call log.info', () => {
      iastLog.info('info')

      expect(log.info).to.be.calledOnceWith('info')
    })

    it('should call log.info and publish msg via telemetry', () => {
      logCollector.init(telemetryDebugConfig.config)

      iastLog.infoAndPublish('info')

      expect(log.info).to.be.calledOnceWith('info')
      expect(logCollector.add).to.be.calledOnceWith({ message: 'info', level: 'DEBUG' })
    })

    it('should chain multiple info calls', () => {
      logCollector.init(telemetryDebugConfig.config)

      iastLog.info('info').infoAndPublish('infoAndPublish').info('info2')

      expect(log.info).to.be.calledThrice
      expect(log.info.firstCall.args[0]).to.be.eq('info')
      expect(log.info.getCall(1).args[0]).to.be.eq('infoAndPublish')
      expect(log.info.getCall(2).args[0]).to.be.eq('info2')
      expect(logCollector.add).to.be.calledOnceWith({ message: 'infoAndPublish', level: 'DEBUG' })
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
      expect(logCollector.add).to.be.calledOnceWith({ message: 'warn', level: 'WARN' })
    })

    it('should chain multiple warn calls', () => {
      iastLog.warn('warn').warnAndPublish('warnAndPublish').warn('warn2')

      expect(log.warn).to.be.calledThrice
      expect(log.warn.firstCall.args[0]).to.be.eq('warn')
      expect(log.warn.getCall(1).args[0]).to.be.eq('warnAndPublish')
      expect(log.warn.getCall(2).args[0]).to.be.eq('warn2')
      expect(logCollector.add).to.be.calledOnceWith({ message: 'warnAndPublish', level: 'WARN' })
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
      expect(logCollector.add).to.be.calledOnceWith({ message: 'error', level: 'ERROR' })
    })

    it('should chain multiple error calls', () => {
      iastLog.error('error').errorAndPublish('errorAndPublish').error('error2')

      expect(log.error).to.be.calledThrice
      expect(log.error.firstCall.args[0]).to.be.eq('error')
      expect(log.error.getCall(1).args[0]).to.be.eq('errorAndPublish')
      expect(log.error.getCall(2).args[0]).to.be.eq('error2')
      expect(logCollector.add).to.be.calledOnceWith({ message: 'errorAndPublish', level: 'ERROR' })
    })

    it('should include original message and dd frames', () => {
      const ddFrame = `at T (${ddBasePath}packages/dd-trace/test/appsec/iast/telemetry/log-collector.spec.js:29:21)`
      const stack = new Error('Error 1')
        .stack.replace(`Error 1${EOL}`, `Error 1${EOL}${ddFrame}${EOL}`)

      const ddFrames = stack
        .split(EOL)
        .filter(line => line.includes(ddBasePath))
        .map(line => line.replace(ddBasePath, ''))

      iastLog.errorAndPublish({ message: 'Error 1', stack })

      expect(logCollector.add).to.be.calledOnce
      const log = logCollector.add.firstCall.args[0]

      expect(log.message).to.be.eq('Error 1')
      expect(log.level).to.be.eq('ERROR')

      log.stack_trace.split(EOL).forEach((frame, index) => {
        if (index !== 0) {
          expect(ddFrames.indexOf(frame) !== -1).to.be.true
        }
      })
    })

    it('should not include original message if first frame is not a dd frame', () => {
      const thirdPartyFrame = `at callFn (/this/is/not/a/dd/frame/runnable.js:366:21)
        at T (${ddBasePath}packages/dd-trace/test/appsec/iast/telemetry/log-collector.spec.js:29:21)`
      const stack = new Error('Error 1')
        .stack.replace(`Error 1${EOL}`, `Error 1${EOL}${thirdPartyFrame}${EOL}`)

      const ddFrames = stack
        .split(EOL)
        .filter(line => line.includes(ddBasePath))
        .map(line => line.replace(ddBasePath, ''))

      iastLog.errorAndPublish({ message: 'Error 1', stack })

      expect(logCollector.add).to.be.calledOnce

      const log = logCollector.add.firstCall.args[0]
      expect(log.message).to.be.eq('omitted')
      expect(log.level).to.be.eq('ERROR')

      log.stack_trace.split(EOL).forEach((frame, index) => {
        if (index !== 0) {
          expect(ddFrames.indexOf(frame) !== -1).to.be.true
        }
      })
    })

    it('should not publish any log if stack_trace is empty', () => {
      iastLog = proxyquire('../../../src/appsec/iast/iast-log', {
        '../telemetry/log-collector': logCollector,
        '../../log': log
      })
      const thirdPartyFrame = `at callFn (/this/is/not/a/dd/frame/runnable.js:366:21)`
      const stack = `Error 1${EOL}${thirdPartyFrame}${EOL}`

      iastLog.errorAndPublish({ message: 'Error 1', stack })

      expect(logCollector.add).to.be.calledWith(undefined)
    })

    it('should not include original message and sanitize with DEBUG verbosity', () => {
      iastLog = proxyquire('../../../src/appsec/iast/iast-log', {
        '../telemetry': {
          isLogCollectionDebugEnabled: () => true
        },
        '../telemetry/log-collector': logCollector,
        '../../log': log
      })

      const thirdPartyFrame = `at callFn (/this/is/not/a/dd/frame/runnable.js:366:21)
        at T (${ddBasePath}packages/dd-trace/test/appsec/iast/telemetry/log-collector.spec.js:29:21)`
      const stack = new Error('Error 1')
        .stack.replace(`Error 1${EOL}`, `Error 1${EOL}${thirdPartyFrame}${EOL}`)

      const ddFrames = stack
        .split(EOL)
        .filter(line => line.includes(ddBasePath))
        .map(line => line.replace(ddBasePath, ''))

      iastLog.errorAndPublish({ message: 'Error 1', stack })

      expect(logCollector.add).to.be.calledOnce

      const logEntry = logCollector.add.firstCall.args[0]
      expect(logEntry.message).to.be.eq('omitted')
      expect(logEntry.level).to.be.eq('ERROR')

      logEntry.stack_trace.split(EOL).forEach((frame, index) => {
        if (index !== 0) {
          expect(ddFrames.indexOf(frame) !== -1).to.be.true
        }
      })
    })
  })
})
