'use strict'

const inspector = require('../../../../src/debugger/devtools_client/inspector_promises_polyfill')
const session = module.exports = new inspector.Session()
session.connect()

session['@noCallThru'] = true
proxyquire('../src/debugger/devtools_client/snapshot/collector', {
  '../session': session
})
proxyquire('../src/debugger/devtools_client/snapshot/redaction', {
  '../config': {
    dynamicInstrumentation: {
      redactedIdentifiers: [],
      redactionExcludedIdentifiers: []
    },
    '@noCallThru': true
  }
})
