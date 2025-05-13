'use strict'

const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')
const proxyquire = require('../proxyquire')
const { NODE_MAJOR } = require('../../../../version')

{
  // get-port can often return a port that is already in use, thanks to a race
  // condition. This patch adds a retry for 10 iterations, which should be
  // enough to avoid flaky tests. The patch is added here in the require cache
  // because it's used in all sorts of places.
  const getPort = require('get-port')
  require.cache[require.resolve('get-port')].exports = async function (...args) {
    let tries = 0
    let err = null
    while (tries++ < 10) {
      try {
        return await getPort(...args)
      } catch (e) {
        if (e.code !== 'EADDRINUSE') {
          throw e
        }
        err = e
      }
    }
    throw err
  }
}

chai.use(sinonChai)
chai.use(require('../asserts/profile'))

global.sinon = sinon
global.expect = chai.expect
global.proxyquire = proxyquire

if (global.describe && typeof global.describe.skip !== 'function') {
  global.describe.skip = function (name, fn, opts = {}) {
    return global.describe(name, fn, { skip: true, ...opts })
  }
}

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

// If this is a release PR, set the SSI variables.
if (/^v\d+\.x$/.test(process.env.GITHUB_BASE_REF || '')) {
  process.env.DD_INJECTION_ENABLED = 'true'
  process.env.DD_INJECT_FORCE = 'true'
}

// TODO(bengl): remove this block once we can properly support Node.js 24 without it
if (NODE_MAJOR >= 24 && !process.env.OPTIONS_OVERRIDE) {
  const childProcess = require('child_process')
  const { exec, fork } = childProcess

  childProcess.exec = function (...args) {
    const opts = args[1]
    if (opts) {
      if (opts?.env?.NODE_OPTIONS && !opts.env.NODE_OPTIONS.includes('--no-async-context-frame')) {
        opts.env.NODE_OPTIONS += ' --no-async-context-frame'
      } else {
        opts.env ||= {}
        opts.env.NODE_OPTIONS = '--no-async-context-frame'
      }
    }
    return exec.apply(this, args)
  }

  childProcess.fork = function (...args) {
    const opts = args[1]
    if (opts) {
      if (opts?.env?.NODE_OPTIONS && !opts.env.NODE_OPTIONS.includes('--no-async-context-frame')) {
        opts.env.NODE_OPTIONS += ' --no-async-context-frame'
      } else {
        opts.env ||= {}
        opts.env.NODE_OPTIONS = '--no-async-context-frame'
      }
    }
    return fork.apply(this, args)
  }
}
