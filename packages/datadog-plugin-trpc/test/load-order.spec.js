'use strict'

const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const fixture = path.join(__dirname, 'integration-test/load-order.cjs')

describe('trpc plugin load order', () => {
  for (const order of ['http-first', 'trpc-first']) {
    it(`preserves procedure tracing and HTTP naming with ${order}`, async () => {
      await execFileAsync(process.execPath, [fixture, order])
    })

    for (const value of ['false', '0', 'true', '1']) {
      it(`honors DD_TRACE_TRPC_ENABLED=${value} with ${order}`, async () => {
        const enabled = value === 'true' || value === '1'
        await execFileAsync(process.execPath, [fixture, order, enabled ? 'enabled' : 'disabled'], {
          env: { ...process.env, DD_TRACE_TRPC_ENABLED: value },
        })
      })
    }
  }
})
