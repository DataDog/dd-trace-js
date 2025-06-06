'use strict'

const { Profiler, ServerlessProfiler } = require('./profiler')
const WallProfiler = require('./profilers/wall')
const SpaceProfiler = require('./profilers/space')
const { AgentExporter } = require('./exporters/agent')
const { FileExporter } = require('./exporters/file')
const { ConsoleLogger } = require('./loggers/console')
const { getEnvironmentVariable } = require('../config-helper')

const profiler = getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') ? new ServerlessProfiler() : new Profiler()

module.exports = {
  profiler,
  AgentExporter,
  FileExporter,
  WallProfiler,
  SpaceProfiler,
  ConsoleLogger
}
