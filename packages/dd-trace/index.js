'use strict'

const TracerProxy = require('./src/proxy')

module.exports = new TracerProxy()
module.exports.default = module.exports
module.exports.tracer = module.exports
