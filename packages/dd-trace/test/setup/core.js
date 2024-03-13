'use strict'

const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')
const proxyquire = require('../proxyquire')

chai.use(sinonChai)
chai.use(require('../asserts/profile'))

globalThis.sinon = sinon
globalThis.expect = chai.expect
globalThis.proxyquire = proxyquire

if (globalThis.describe && typeof globalThis.describe.skip !== 'function') {
  globalThis.describe.skip = function (name, fn, opts = {}) {
    return globalThis.describe(name, fn, { skip: true, ...opts })
  }
}

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'
