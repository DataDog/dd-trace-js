'use strict'

require('./setup/tap')
const { expect } = require('chai')
const { exec } = require('node:child_process')

describe('check_require_cache', () => {
  const opts = {
    cwd: __dirname,
    env: {
      DD_TRACE_DEBUG: 'true'
    }
  }

  it('should be no warnings when tracer is loaded first', (done) => {
    exec(`${process.execPath} ./check_require_cache/good-order.js`, opts, (error, stdout, stderr) => {
      if (error) {
        return done(error)
      }

      if (stdout) {
        return done(stdout)
      }

      if (stderr) {
        return done(stderr)
      }

      done()
    })
  })

  it('should find warnings when tracer loaded late', (done) => {
    exec(`${process.execPath} ./check_require_cache/bad-order.js`, opts, (error, stdout, stderr) => {
      if (error) {
        return done(error)
      }

      if (stdout) {
        return done(stdout)
      }

      if (!stderr) {
        return done('expected an error string')
      }

      expect(stderr).to.include("Package 'express' was loaded")

      done()
    })
  })
})
