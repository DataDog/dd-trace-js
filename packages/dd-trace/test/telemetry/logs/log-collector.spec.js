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

    it('should redact error messages and keep Datadog frames', () => {
      const ddFrame = `at T (${ddBasePath}path/to/dd/file.js:1:2)`
      const stack = `TypeError: Error 1${EOL}${ddFrame}${EOL}    at user (/customer/app.js:1:2)`

      assert.strictEqual(logCollector.add({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: stack,
        errorType: 'TypeError',
      }), true)

      assert.strictEqual(logCollector.hasEntry({
        message: 'Error 1',
        level: 'ERROR',
        stack_trace: `TypeError: redacted${EOL}at T (path/to/dd/file.js:1:2)`,
      }), true)
    })

    it('should redact error message regardless of whether first frame is DD code', () => {
      const stack = [
        'TypeError: Error 1',
        '    at callFn (/this/is/not/a/dd/frame/runnable.js:366:21)',
        `    at T (${ddBasePath}path/to/dd/file.js:1:2)`,
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
        stack_trace: `TypeError: redacted${EOL}    at T (path/to/dd/file.js:1:2)`,
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

    it('should retain runtime locations when no Datadog frames survive', () => {
      logCollector.add({
        message: '[debugger] worker thread error',
        level: 'ERROR',
        errorType: 'Error',
        stack_trace: [
          'Error: Cannot find module /customer/secret.js',
          'Require stack:',
          '- /customer/app.js',
          '    at Function._resolveFilename (node:internal/modules/cjs/loader:1365:15)',
          '    at customerFunction (/customer/app.js:10:2)',
          '    at customerName (node:events:518:28)',
          '    at node:internal/main/worker_thread:206:26',
        ].join(EOL),
      })

      assert.deepStrictEqual(logCollector.drain(), [{
        message: '[debugger] worker thread error',
        level: 'ERROR',
        stack_trace: [
          'Error: redacted',
          '    at node:internal/modules/cjs/loader:1365:15',
          '    at node:events:518:28',
          '    at node:internal/main/worker_thread:206:26',
        ].join(EOL),
      }])
    })

    it('should retain Datadog and runtime frames in their original order', () => {
      logCollector.add({
        message: 'failure',
        level: 'ERROR',
        errorType: 'TypeError',
        stack_trace: [
          'TypeError: secret',
          '    at customerName (node:events:518:28)',
          `    at send (${ddBasePath}packages/dd-trace/src/debugger/devtools_client/send.js:10:2)`,
          '    at /customer/app.js:1:2',
          '    at processTicksAndRejections (node:internal/process/task_queues:105:5)',
          `    at start (${ddBasePath}packages/dd-trace/src/debugger/index.js:20:3)`,
          '    at node:internal/main/worker_thread:206:26',
        ].join(EOL),
      })

      const entries = logCollector.drain()
      assert.ok(entries)
      assert.strictEqual(entries[0].stack_trace, [
        'TypeError: redacted',
        '    at node:events:518:28',
        '    at send (packages/dd-trace/src/debugger/devtools_client/send.js:10:2)',
        '    at node:internal/process/task_queues:105:5',
        '    at start (packages/dd-trace/src/debugger/index.js:20:3)',
        '    at node:internal/main/worker_thread:206:26',
      ].join(EOL))
    })

    it('should deduplicate mixed stacks by sanitized locations', () => {
      for (const [name, location] of [
        ['customerOne', 'node:events:518:28'],
        ['customerTwo', 'node:events:518:28'],
        ['customerOne', 'node:internal/process/task_queues:105:5'],
      ]) {
        logCollector.add({
          message: 'failure',
          level: 'ERROR',
          count: 1,
          errorType: 'Error',
          stack_trace: [
            'Error: secret',
            `    at send (${ddBasePath}send.js:1:2)`,
            `    at ${name} (${location})`,
          ].join(EOL),
        })
      }

      assert.deepStrictEqual(logCollector.drain(), [
        {
          message: 'failure',
          level: 'ERROR',
          count: 2,
          stack_trace: 'Error: redacted\n    at send (send.js:1:2)\n    at node:events:518:28',
        },
        {
          message: 'failure',
          level: 'ERROR',
          count: 1,
          stack_trace: 'Error: redacted\n    at send (send.js:1:2)\n    at node:internal/process/task_queues:105:5',
        },
      ])
    })

    it('should retain runtime-only generic errors without requiring an error type', () => {
      assert.strictEqual(logCollector.add({
        message: 'Generic Error',
        level: 'ERROR',
        stack_trace: 'Error: secret\n    at node:internal/main/worker_thread:206:26',
      }), true)

      const entries = logCollector.drain()
      assert.ok(entries)
      assert.strictEqual(entries[0].stack_trace, '    at node:internal/main/worker_thread:206:26')
    })

    for (const frame of [
      '    at /customer/node:events:518:28',
      '    at node:events (/customer/app.js:518:28)',
      '    at file:///customer/node:internal/main/worker_thread:206:26',
      '    at eval (eval at run (/customer/app.js:1:2), node:events:518:28)',
      '    at node:internal/main/worker_thread:206:26 /customer/secret',
      '    at node:internal/main/worker_thread:206',
      '    at run (node:internal/main/worker_thread:206:26',
      '    at node:internal/main/worker_thread:206:26)',
      'node:internal/main/worker_thread:206:26',
      'Error: node:internal/main/worker_thread:206:26',
      '',
    ]) {
      it(`should reject non-runtime locations and malformed frames: ${JSON.stringify(frame)}`, () => {
        assert.strictEqual(logCollector.add({
          message: 'Generic Error',
          level: 'ERROR',
          errorType: 'Error',
          stack_trace: `Error: secret\n${frame}`,
        }), false)
        assert.strictEqual(logCollector.drain(), undefined)

        logCollector.add({
          message: 'failure',
          level: 'ERROR',
          errorType: 'Error',
          stack_trace: `Error: secret\n    at send (${ddBasePath}send.js:1:2)\n${frame}`,
        })
        assert.deepStrictEqual(logCollector.drain(), [{
          message: 'failure',
          level: 'ERROR',
          stack_trace: 'Error: redacted\n    at send (send.js:1:2)',
        }])
      })
    }
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
