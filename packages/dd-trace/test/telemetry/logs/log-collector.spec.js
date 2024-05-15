'use strict'

require('../../setup/tap')

const { calculateDDBasePath } = require('../../../src/util')

const ddBasePath = calculateDDBasePath(__dirname)
const EOL = '\n'

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

    it('should include original message and dd frames', () => {
      const ddFrame = `at T (${ddBasePath}packages/dd-trace/test/telemetry/logs/log_collector.spec.js:29:21)`
      const stack = new Error('Error 1')
        .stack.replace(`Error 1${EOL}`, `Error 1${EOL}${ddFrame}${EOL}`)

      const ddFrames = stack
        .split(EOL)
        .filter(line => line.includes(ddBasePath))
        .map(line => line.replace(ddBasePath, ''))
        .join(EOL)

      expect(logCollector.add({ message: 'Error 1', level: 'ERROR', stack_trace: stack })).to.be.true

      expect(logCollector.hasEntry({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: `Error: Error 1${EOL}${ddFrames}`
      })).to.be.true
    })

    it('should not include original message if first frame is not a dd frame', () => {
      const thirdPartyFrame = `at callFn (/this/is/not/a/dd/frame/runnable.js:366:21)
        at T (${ddBasePath}packages/dd-trace/test/telemetry/logs/log_collector.spec.js:29:21)`
      const stack = new Error('Error 1')
        .stack.replace(`Error 1${EOL}`, `Error 1${EOL}${thirdPartyFrame}${EOL}`)

      const ddFrames = stack
        .split(EOL)
        .filter(line => line.includes(ddBasePath))
        .map(line => line.replace(ddBasePath, ''))
        .join(EOL)

      expect(logCollector.add({ message: 'Error 1', level: 'ERROR', stack_trace: stack })).to.be.true
      expect(logCollector.hasEntry({
        message: 'omitted',
        level: 'ERROR',
        stack_trace: ddFrames
      })).to.be.true
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
