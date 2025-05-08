'use strict'

const inspector = require('node:inspector/promises')

const session = module.exports = new inspector.Session()

session.connectToMainThread()
