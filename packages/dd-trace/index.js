'use strict'

const platform = require('./src/platform')
const node = require('./src/platform/node')

platform.use(node)

const TracerProxy = require('./src/proxy')

module.exports = new TracerProxy()
module.exports.default = module.exports
module.exports.tracer = module.exports
