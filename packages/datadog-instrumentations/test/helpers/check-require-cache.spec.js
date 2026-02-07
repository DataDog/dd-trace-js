'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')

const { describe, it } = require('mocha')

describe('check-require-cache', () => {
  const opts = {
    cwd: __dirname,
    env: {
      DD_TRACE_DEBUG: 'true',
    },
  }

  it('should be no warnings when tracer is loaded first', (done) => {
    exec(`${process.execPath} ./check-require-cache/good-order.js`, opts, (error, stdout, stderr) => {
      assert.strictEqual(error, null)
      assert.doesNotMatch(stderr, /Package 'express' was loaded/)
      done()
    })
  })

  it('should find warnings when tracer loaded late', (done) => {
    exec(`${process.execPath} ./check-require-cache/bad-order.js`, opts, (error, stdout, stderr) => {
      assert.strictEqual(error, null)
      assert.match(stderr, /Package 'express' was loaded/)
      done()
    })
  })
})
