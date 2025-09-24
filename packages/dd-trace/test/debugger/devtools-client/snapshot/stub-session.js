'use strict'

const inspector = require('../../../../src/debugger/devtools-client/inspector-promises-polyfill')
const session = module.exports = new inspector.Session()
session.connect()

session['@noCallThru'] = true
