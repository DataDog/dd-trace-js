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
  }
})
