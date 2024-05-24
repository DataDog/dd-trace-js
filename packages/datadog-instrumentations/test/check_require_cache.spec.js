'use strict'

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
      expect(error).to.be.null
      expect(stdout).to.be.empty
      expect(stderr).to.be.empty
      done()
    })
  })

  // stderr is empty on Windows
  if (process.platform !== 'windows') {
    it('should find warnings when tracer loaded late', (done) => {
      exec(`${process.execPath} ./check_require_cache/bad-order.js`, opts, (error, stdout, stderr) => {
        expect(error).to.be.null
        expect(stdout).to.be.empty
        expect(stderr).to.not.be.empty
        expect(stderr).to.include("Package 'express' was loaded")
        done()
      })
    })
  }
})
