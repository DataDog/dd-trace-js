'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { join } = require('node:path')

describe('OpenFeature worker logging', () => {
  for (const [enabled, level, environmentLevel] of [
    [true, 'debug', 'error'], [true, 'error', 'debug'], [false, 'debug', 'debug'],
  ]) {
    it(`uses the application logger with enabled=${enabled}, level=${level}`, async () => {
      const { stdout, stderr } = await new Promise((resolve, reject) => {
        execFile(process.execPath, [join(__dirname, 'app/worker-logging.js'), level], {
          timeout: 10000,
          env: {
            ...process.env,
            DD_TRACE_DEBUG: String(enabled),
            DD_TRACE_LOG_LEVEL: environmentLevel,
          },
        }, (error, stdout, stderr) => {
          if (error) reject(error)
          else resolve({ stdout, stderr })
        })
      })
      assert.strictEqual(stderr, '')
      const { logs, telemetryErrors, requests } = JSON.parse(stdout)
      assert.strictEqual(requests, 2)
      assert.deepStrictEqual(telemetryErrors, [])
      const successes = logs.filter(entry => entry.message.includes('Successfully sent 1 events'))
      const failures = logs.filter(entry => entry.message.includes('Failed to send events to'))
      assert.strictEqual(successes.length, enabled && level === 'debug' ? 1 : 0)
      assert.strictEqual(failures.length, enabled ? 1 : 0)
      if (enabled) {
        assert.strictEqual(failures[0].level, 'error')
        assert.ok(failures[0].message.includes('socket hang up'))
      } else {
        assert.deepStrictEqual(logs, [])
      }
    })
  }
})
