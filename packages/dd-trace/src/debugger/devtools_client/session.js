'use strict'

const inspector = require('./inspector_promises_polyfill')

const session = module.exports = new inspector.Session()

session.connectToMainThread()
