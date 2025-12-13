'use strict'

const inspector = require('../../../../src/debugger/devtools_client/inspector_promises_polyfill')
const session = module.exports = /** @type {import('../../../../src/debugger/devtools_client/session').CDPSession} */
  (new inspector.Session())
session.connect()

session['@noCallThru'] = true
