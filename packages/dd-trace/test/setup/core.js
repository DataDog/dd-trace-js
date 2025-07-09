'use strict'

const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')
const proxyquire = require('../proxyquire')
const { NODE_MAJOR } = require('../../../../version')

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

  function addAsyncContextFrame (fn, thisArg, args) {
    const opts = args[1]
    if (opts) {
      const env = opts.env ||= {}
      env.NODE_OPTIONS ||= ''
      if (!env.NODE_OPTIONS.includes('--no-async-context-frame')) {
        env.NODE_OPTIONS += ' --no-async-context-frame'
      }
    }
    return fn.apply(thisArg, args)
  }

  childProcess.exec = function () {
    return addAsyncContextFrame(exec, this, arguments)
  }

  childProcess.fork = function () {
    return addAsyncContextFrame(fork, this, arguments)
  }
}
