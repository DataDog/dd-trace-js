'use strict'

const t = require('tap')
require('../../setup/core')

const { ddBasePath } = require('../../../src/util')

const EOL = '\n'

t.test('telemetry log collector', t => {
  const logCollector = require('../../../src/telemetry/logs/log-collector')

  t.afterEach(() => {
    logCollector.reset(3)
  })

  t.test('add', t => {
    t.test('should not store logs with same hash', t => {
      expect(logCollector.add({ message: 'Error', level: 'ERROR' })).to.be.true
      expect(logCollector.add({ message: 'Error', level: 'ERROR' })).to.be.false
      expect(logCollector.add({ message: 'Error', level: 'ERROR' })).to.be.false
      t.end()
    })

    t.test('should store logs with different message', t => {
      expect(logCollector.add({ message: 'Error 1', level: 'ERROR' })).to.be.true
      expect(logCollector.add({ message: 'Error 2', level: 'ERROR' })).to.be.true
      expect(logCollector.add({ message: 'Warn 1', level: 'WARN' })).to.be.true
      t.end()
    })

    t.test('should store logs with same message but different stack', t => {
      const ddFrame = `at T (${ddBasePath}path/to/dd/file.js:1:2)`
      expect(logCollector.add({ message: 'Error 1', level: 'ERROR', stack_trace: `stack 1\n${ddFrame}` })).to.be.true
      expect(logCollector.add({ message: 'Error 1', level: 'ERROR', stack_trace: `stack 2\n${ddFrame}` })).to.be.true
      expect(logCollector.add({ message: 'Error 1', level: 'ERROR', stack_trace: `stack 3\n${ddFrame}` })).to.be.true
      t.end()
    })

    t.test('should store logs with same message, same stack but different level', t => {
      const ddFrame = `at T (${ddBasePath}path/to/dd/file.js:1:2)`
      expect(logCollector.add({ message: 'Error 1', level: 'ERROR', stack_trace: `stack 1\n${ddFrame}` })).to.be.true
      expect(logCollector.add({ message: 'Error 1', level: 'WARN', stack_trace: `stack 1\n${ddFrame}` })).to.be.true
      expect(logCollector.add({ message: 'Error 1', level: 'DEBUG', stack_trace: `stack 1\n${ddFrame}` })).to.be.true
      t.end()
    })

    t.test('should not store logs with empty stack and \'Generic Error\' message', t => {
      expect(logCollector.add({
        message: 'Generic Error',
        level: 'ERROR',
        stack_trace: 'stack 1\n/not/a/dd/frame'
      })
      ).to.be.false
      t.end()
    })

    t.test('should include original message and dd frames', t => {
      const ddFrame = `at T (${ddBasePath}path/to/dd/file.js:1:2)`
      const stack = new TypeError('Error 1')
        .stack.replace(`Error 1${EOL}`, `Error 1${EOL}${ddFrame}${EOL}`)

      const ddFrames = stack
        .split(EOL)
        .filter(line => line.includes(ddBasePath))
        .map(line => line.replace(ddBasePath, ''))
        .join(EOL)

      expect(logCollector.add({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: stack,
        errorType: 'TypeError'
      })).to.be.true

      expect(logCollector.hasEntry({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: `TypeError: Error 1${EOL}${ddFrames}`
      })).to.be.true
      t.end()
    })

    t.test('should redact stack message if first frame is not a dd frame', t => {
      const thirdPartyFrame = `at callFn (/this/is/not/a/dd/frame/runnable.js:366:21)
        at T (${ddBasePath}path/to/dd/file.js:1:2)`
      const stack = new TypeError('Error 1')
        .stack.replace(`Error 1${EOL}`, `Error 1${EOL}${thirdPartyFrame}${EOL}`)

      const ddFrames = [
        'TypeError: redacted',
        ...stack
          .split(EOL)
          .filter(line => line.includes(ddBasePath))
          .map(line => line.replace(ddBasePath, ''))
      ].join(EOL)

      expect(logCollector.add({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: stack,
        errorType: 'TypeError'
      })).to.be.true

      expect(logCollector.hasEntry({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: ddFrames
      })).to.be.true
      t.end()
    })
    t.end()
  })

  t.test('drain', t => {
    t.test('should empty stored logs', t => {
      logCollector.add({ message: 'Error 1', level: 'ERROR' })
      logCollector.add({ message: 'Error 2', level: 'ERROR' })

      expect(logCollector.drain().length).to.be.equal(2)
      expect(logCollector.drain()).to.be.undefined
      t.end()
    })

    t.test('should add an error log when max size is reached', t => {
      logCollector.add({ message: 'Error 1', level: 'ERROR' })
      logCollector.add({ message: 'Error 2', level: 'ERROR' })
      logCollector.add({ message: 'Warn 1', level: 'WARN' })
      logCollector.add({ message: 'Error 4', level: 'ERROR' })
      logCollector.add({ message: 'Error 5', level: 'ERROR' })

      const logs = logCollector.drain()
      expect(logs.length).to.be.equal(4)
      expect(logs[3]).to.deep.eq({ message: 'Omitted 2 entries due to overflowing', level: 'ERROR' })
      t.end()
    })

    t.test('duplicated errors should send incremented count values', t => {
      const err1 = { message: 'oh no', level: 'ERROR', count: 1 }

      const err2 = { message: 'foo buzz', level: 'ERROR', count: 1 }

      logCollector.add(err1)
      logCollector.add(err2)
      logCollector.add(err1)
      logCollector.add(err2)
      logCollector.add(err1)

      const drainedErrors = logCollector.drain()
      expect(drainedErrors.length).to.be.equal(2)
      expect(drainedErrors[0].count).to.be.equal(3)
      expect(drainedErrors[1].count).to.be.equal(2)
      t.end()
    })
    t.end()
  })
  t.end()
})
