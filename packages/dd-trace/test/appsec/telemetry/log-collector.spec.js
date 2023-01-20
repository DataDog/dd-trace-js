const { expect } = require('chai')
const { calculateDDBasePath } = require('../../../src/util')

const ddBasePath = calculateDDBasePath(__dirname)

describe('telemetry log collector', () => {
  const { init, add, getLogs, drain } = require('../../../src/appsec/telemetry/log-collector')

  let defaultConfig
  beforeEach(() => {
    defaultConfig = {
      enabled: true,
      logCollection: true,
      debug: false
    }
    init(defaultConfig, 3)
  })

  describe('add', () => {
    it('should not store logs with same hash', () => {
      expect(add({ message: 'Error', level: 'ERROR' })).to.be.true
      expect(add({ message: 'Error', level: 'ERROR' })).to.be.false
      expect(add({ message: 'Error', level: 'ERROR' })).to.be.false
    })

    it('should store logs with different message', () => {
      expect(add({ message: 'Error 1', level: 'ERROR' })).to.be.true
      expect(add({ message: 'Error 2', level: 'ERROR' })).to.be.true
      expect(add({ message: 'Warn 1', level: 'WARN' })).to.be.true
    })

    it('should store logs with same message but different stack', () => {
      const ddFrame = `at T (${ddBasePath}packages/dd-trace/test/appsec/telemetry/api/log-collector.spec.js:29:21)`
      expect(add({ message: 'Error 1', level: 'ERROR', stack_trace: `stack 1\n${ddFrame}` })).to.be.true
      expect(add({ message: 'Error 1', level: 'ERROR', stack_trace: `stack 2\n${ddFrame}` })).to.be.true
      expect(add({ message: 'Error 1', level: 'ERROR', stack_trace: `stack 3\n${ddFrame}` })).to.be.true
    })

    it('should store logs with same message, same stack but different level', () => {
      defaultConfig.debug = true
      init(defaultConfig)

      const ddFrame = `at T (${ddBasePath}packages/dd-trace/test/appsec/telemetry/api/log-collector.spec.js:29:21)`
      expect(add({ message: 'Error 1', level: 'ERROR', stack_trace: `stack 1\n${ddFrame}` })).to.be.true
      expect(add({ message: 'Error 1', level: 'WARN', stack_trace: `stack 1\n${ddFrame}` })).to.be.true
      expect(add({ message: 'Error 1', level: 'DEBUG', stack_trace: `stack 1\n${ddFrame}` })).to.be.true
    })

    it('should be called with DEBUG level and error if config.telemetry.debug = true', () => {
      defaultConfig.debug = true
      init(defaultConfig)

      const error = new Error('test')
      const stack = error.stack
      add({ message: error.message, stack_trace: stack, level: 'DEBUG' })

      expect(getLogs()[0]).to.be.deep.eq({ message: 'test', level: 'DEBUG', stack_trace: stack })
    })

    it('should be not called with DEBUG level if config.telemetry.debug = false', () => {
      add({ message: 'message', level: 'DEBUG' })

      expect(getLogs()).to.be.empty
    })

    it('should be called with WARN level', () => {
      add({ message: 'message', level: 'WARN' })

      expect(getLogs()[0]).to.be.deep.eq({ message: 'message', level: 'WARN' })
    })

    it('should be called with ERROR level', () => {
      add({ message: 'message', level: 'ERROR' })

      expect(getLogs()[0]).to.be.deep.eq({ message: 'message', level: 'ERROR' })
    })

    it('should be called with ERROR level and stack_trace', () => {
      const error = new Error('message')
      const stack = error.stack
      add({ message: error.message, stack_trace: stack, level: 'ERROR' })

      expect(getLogs()[0]).to.be.deep.eq({ message: 'message', level: 'ERROR', stack_trace: stack })
    })
  })

  describe('drain', () => {
    it('should empty stored logs', () => {
      add({ message: 'Error 1', level: 'ERROR' })
      add({ message: 'Error 2', level: 'ERROR' })

      expect(drain().length).to.be.equal(2)
      expect(drain()).to.be.undefined
    })

    it('should add an error log when max size is reached', () => {
      add({ message: 'Error 1', level: 'ERROR' })
      add({ message: 'Error 2', level: 'ERROR' })
      add({ message: 'Warn 1', level: 'WARN' })
      add({ message: 'Error 4', level: 'ERROR' })
      add({ message: 'Error 5', level: 'ERROR' })

      const logs = drain()
      expect(logs.length).to.be.equal(4)
      expect(logs[3]).to.deep.eq({ message: 'Omitted 2 entries due to overflowing', level: 'ERROR', tags: undefined })
    })
  })
})
