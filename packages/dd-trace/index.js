'use strict'

const platform = require('./src/platform')
const node = require('./src/platform/node')
const { LOG_EXPORTER, AGENT_EXPORTER } = require('./src/constants')
platform.use(node)

const TracerProxy = require('./src/proxy')

module.exports = new TracerProxy()

module.exports.default = module.exports
module.exports.tracer = module.exports
module.exports.LOG_EXPORTER = LOG_EXPORTER
module.exports.AGENT_EXPORTER = AGENT_EXPORTER
