'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { describe, it } = require('mocha')

require('./setup/core')

const ddTraceEntry = path.resolve(__dirname, '..', 'index.js')

describe('ESM named exports', () => {
  it('exposes `tracer` and `default` to ESM consumers', () => {
    const script = `
      import tracerDefault, { tracer } from ${JSON.stringify(ddTraceEntry)}

      if (tracerDefault !== tracer) {
        process.stderr.write('default !== tracer\\n')
        process.exit(2)
      }
      if (typeof tracer.init !== 'function') {
        process.stderr.write('tracer.init is not a function\\n')
        process.exit(3)
      }
      process.stdout.write('ok')
    `

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const detail = `child exited with ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    assert.equal(result.status, 0, detail)
    assert.equal(result.stdout, 'ok')
  })
})
