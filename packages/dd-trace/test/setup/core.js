'use strict'

const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')
const proxyquire = require('../proxyquire')

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
