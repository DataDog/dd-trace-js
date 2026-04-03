'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')

require('../../setup/core')
const { ddBasePath } = require('../../../src/util')

const EOL = '\n'

describe('telemetry log collector', () => {
  const logCollector = require('../../../src/telemetry/logs/log-collector')

  afterEach(() => {
    logCollector.reset(3)
  })

  describe('add', () => {
    it('should not store logs with same hash', () => {
      assert.strictEqual(logCollector.add({ message: 'Error', level: 'ERROR' }), true)
      assert.strictEqual(logCollector.add({ message: 'Error', level: 'ERROR' }), false)
      assert.strictEqual(logCollector.add({ message: 'Error', level: 'ERROR' }), false)
    })

    it('should store logs with different message', () => {
      assert.strictEqual(logCollector.add({ message: 'Error 1', level: 'ERROR' }), true)
      assert.strictEqual(logCollector.add({ message: 'Error 2', level: 'ERROR' }), true)
      assert.strictEqual(logCollector.add({ message: 'Warn 1', level: 'WARN' }), true)
    })

    it('should store logs with same message but different stack', () => {
      const ddFrame1 = `at T (${ddBasePath}path/to/dd/file1.js:1:2)`
      const ddFrame2 = `at T (${ddBasePath}path/to/dd/file2.js:3:4)`
      const ddFrame3 = `at T (${ddBasePath}path/to/dd/file3.js:5:6)`
      assert.strictEqual(logCollector.add({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: `Error: msg\n${ddFrame1}`,
        errorType: 'Error',
      }), true)
      assert.strictEqual(logCollector.add({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: `Error: msg\n${ddFrame2}`,
        errorType: 'Error',
      }), true)
      assert.strictEqual(logCollector.add({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: `Error: msg\n${ddFrame3}`,
        errorType: 'Error',
      }), true)
    })

    it('should store logs with same message, same stack but different level', () => {
      const ddFrame = `at T (${ddBasePath}path/to/dd/file.js:1:2)`
      assert.strictEqual(logCollector.add({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: `Error: msg\n${ddFrame}`,
        errorType: 'Error',
      }), true)
      assert.strictEqual(logCollector.add({
        message: 'Error 1',
        level: 'WARN',
        stack_trace: `Error: msg\n${ddFrame}`,
        errorType: 'Error',
      }), true)
      assert.strictEqual(logCollector.add({
        message: 'Error 1',
        level: 'DEBUG',
        stack_trace: `Error: msg\n${ddFrame}`,
        errorType: 'Error',
      }), true)
    })

    it('should not store logs with empty stack and \'Generic Error\' message', () => {
      assert.strictEqual(logCollector.add({
        message: 'Generic Error',
        level: 'ERROR',
        stack_trace: 'stack 1\n/not/a/dd/frame',
      })
      , false)
    })

    it('should redact error message and include only dd frames', () => {
      const ddFrame = `at T (${ddBasePath}path/to/dd/file.js:1:2)`
      const stack = new TypeError('Error 1')
        .stack.replace(`Error 1${EOL}`, `Error 1${EOL}${ddFrame}${EOL}`)

      const ddFrames = stack
        .split(EOL)
        .filter(line => line.includes(ddBasePath))
        .map(line => line.replace(ddBasePath, ''))
        .join(EOL)

      assert.strictEqual(logCollector.add({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: stack,
        errorType: 'TypeError',
      }), true)

      assert.strictEqual(logCollector.hasEntry({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: `TypeError: redacted${EOL}${ddFrames}`,
      }), true)
    })

    it('should redact error message regardless of whether first frame is DD code', () => {
      const thirdPartyFrame = `at callFn (/this/is/not/a/dd/frame/runnable.js:366:21)
        at T (${ddBasePath}path/to/dd/file.js:1:2)`
      const stack = new TypeError('Error 1')
        .stack.replace(`Error 1${EOL}`, `Error 1${EOL}${thirdPartyFrame}${EOL}`)

      const ddFrames = [
        'TypeError: redacted',
        ...stack
          .split(EOL)
          .filter(line => line.includes(ddBasePath))
          .map(line => line.replace(ddBasePath, '')),
      ].join(EOL)

      assert.strictEqual(logCollector.add({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: stack,
        errorType: 'TypeError',
      }), true)

      assert.strictEqual(logCollector.hasEntry({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: ddFrames,
      }), true)
    })

    it('should redact multi-line error messages', () => {
      const ddFrame = `at cachedExec (${ddBasePath}plugins/util/git-cache.js:96:17)`
      const multiLineError = 'Error: Command failed: git rev-parse --abbrev-ref ' +
        `--symbolic-full-name @{upstream}${EOL}fatal: HEAD does not point to a branch${EOL}${EOL}${ddFrame}`

      const ddFrames = multiLineError
        .split(EOL)
        .filter(line => line.includes(ddBasePath))
        .map(line => line.replace(ddBasePath, ''))
        .join(EOL)

      assert.strictEqual(logCollector.add({
        message: 'Git plugin error',
        level: 'ERROR',
        stack_trace: multiLineError,
        errorType: 'Error',
      }), true)

      assert.strictEqual(logCollector.hasEntry({
        message: 'Git plugin error',
        level: 'ERROR',
        stack_trace: `Error: redacted${EOL}${ddFrames}`,
      }), true)
    })
  })

  describe('drain', () => {
    it('should empty stored logs', () => {
      logCollector.add({ message: 'Error 1', level: 'ERROR' })
      logCollector.add({ message: 'Error 2', level: 'ERROR' })

      assert.strictEqual(logCollector.drain().length, 2)
      assert.strictEqual(logCollector.drain(), undefined)
    })

    it('should add an error log when max size is reached', () => {
      logCollector.add({ message: 'Error 1', level: 'ERROR' })
      logCollector.add({ message: 'Error 2', level: 'ERROR' })
      logCollector.add({ message: 'Warn 1', level: 'WARN' })
      logCollector.add({ message: 'Error 4', level: 'ERROR' })
      logCollector.add({ message: 'Error 5', level: 'ERROR' })

      const logs = logCollector.drain()
      assert.strictEqual(logs.length, 4)
      assert.deepStrictEqual(logs[3], { message: 'Omitted 2 entries due to overflowing', level: 'ERROR' })
    })

    it('duplicated errors should send incremented count values', () => {
      const err1 = { message: 'oh no', level: 'ERROR', count: 1 }

      const err2 = { message: 'foo buzz', level: 'ERROR', count: 1 }

      logCollector.add(err1)
      logCollector.add(err2)
      logCollector.add(err1)
      logCollector.add(err2)
      logCollector.add(err1)

      const drainedErrors = logCollector.drain()
      assert.strictEqual(drainedErrors.length, 2)
      assert.strictEqual(drainedErrors[0].count, 3)
      assert.strictEqual(drainedErrors[1].count, 2)
    })
  })
})
