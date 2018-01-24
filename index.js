'use strict'

var platform = require('./src/platform')
var node = require('./src/platform/node')

platform.use(node)

module.exports = {}
