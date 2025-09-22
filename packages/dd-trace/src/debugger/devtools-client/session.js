'use strict'

const inspector = require('./inspector-promises-polyfill')

const session = module.exports = new inspector.Session()

session.connectToMainThread()
