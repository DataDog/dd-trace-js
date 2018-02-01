'use strict'

const platform = require('./src/platform')
const node = require('./src/platform/node')
const ddtrace = require('./src')

platform.use(node)

module.exports = ddtrace
