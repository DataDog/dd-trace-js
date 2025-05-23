'use strict'

const { exec } = require('node:child_process')

describe('check-require-cache', () => {
  const opts = {
    cwd: __dirname,
    env: {
      DD_TRACE_DEBUG: 'true'
    }
  }

  it('should be no warnings when tracer is loaded first', (done) => {
    exec(`${process.execPath} ./check-require-cache/good-order.js`, opts, (error, stdout, stderr) => {
      expect(error).to.be.null
      expect(stderr).to.not.include("Package 'express' was loaded")
      done()
    })
  })

  // stderr is empty on Windows
  if (process.platform !== 'windows') {
    it('should find warnings when tracer loaded late', (done) => {
      exec(`${process.execPath} ./check-require-cache/bad-order.js`, opts, (error, stdout, stderr) => {
        expect(error).to.be.null
        expect(stderr).to.include("Package 'express' was loaded")
        done()
      })
    })
  }
})
