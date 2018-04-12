'use strict'

const platform = require('./src/platform')
const browser = require('./src/platform/browser')
const TracerProxy = require('./src/proxy')

platform.use(browser)

module.exports = new TracerProxy()
