'use strict'

require('../../setup/tap')

const { calculateDDBasePath } = require('../../../src/util')

const ddBasePath = calculateDDBasePath(__dirname)

describe('telemetry log collector', () => {
  const logCollector = require('../../../src/telemetry/logs/log-collector')

  afterEach(() => {
    logCollector.reset(3)
  })

  describe('add', () => {
    it('should not store logs with same hash', () => {
      expect(logCollector.add({ message: 'Error', level: 'ERROR' })).to.be.true
      expect(logCollector.add({ message: 'Error', level: 'ERROR' })).to.be.false
      expect(logCollector.add({ message: 'Error', level: 'ERROR' })).to.be.false
    })

    it('should store logs with different message', () => {
      expect(logCollector.add({ message: 'Error 1', level: 'ERROR' })).to.be.true
      expect(logCollector.add({ message: 'Error 2', level: 'ERROR' })).to.be.true
      expect(logCollector.add({ message: 'Warn 1', level: 'WARN' })).to.be.true
    })

    it('should store logs with same message but different stack', () => {
      const ddFrame =
        `at T (${ddBasePath}packages/dd-trace/test/telemetry/logs/log-collector.spec.js:29:21)`
      expect(logCollector.add({ message: 'Error 1', level: 'ERROR', stack_trace: `stack 1\n${ddFrame}` })).to.be.true
      expect(logCollector.add({ message: 'Error 1', level: 'ERROR', stack_trace: `stack 2\n${ddFrame}` })).to.be.true
      expect(logCollector.add({ message: 'Error 1', level: 'ERROR', stack_trace: `stack 3\n${ddFrame}` })).to.be.true
    })

    it('should store logs with same message, same stack but different level', () => {
      const ddFrame =
        `at T (${ddBasePath}packages/dd-trace/test/telemetry/logs/log-collector.spec.js:29:21)`
      expect(logCollector.add({ message: 'Error 1', level: 'ERROR', stack_trace: `stack 1\n${ddFrame}` })).to.be.true
      expect(logCollector.add({ message: 'Error 1', level: 'WARN', stack_trace: `stack 1\n${ddFrame}` })).to.be.true
      expect(logCollector.add({ message: 'Error 1', level: 'DEBUG', stack_trace: `stack 1\n${ddFrame}` })).to.be.true
    })
  })

  describe('drain', () => {
    it('should empty stored logs', () => {
      logCollector.add({ message: 'Error 1', level: 'ERROR' })
      logCollector.add({ message: 'Error 2', level: 'ERROR' })

      expect(logCollector.drain().length).to.be.equal(2)
      expect(logCollector.drain()).to.be.undefined
    })

    it('should add an error log when max size is reached', () => {
      logCollector.add({ message: 'Error 1', level: 'ERROR' })
      logCollector.add({ message: 'Error 2', level: 'ERROR' })
      logCollector.add({ message: 'Warn 1', level: 'WARN' })
      logCollector.add({ message: 'Error 4', level: 'ERROR' })
      logCollector.add({ message: 'Error 5', level: 'ERROR' })

      const logs = logCollector.drain()
      expect(logs.length).to.be.equal(4)
      expect(logs[3]).to.deep.eq({ message: 'Omitted 2 entries due to overflowing', level: 'ERROR' })
    })
  })
})
