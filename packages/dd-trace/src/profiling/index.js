'use strict'

const { Profiler, ServerlessProfiler } = require('./profiler')
const CpuProfiler = require('./profilers/cpu')
const WallProfiler = require('./profilers/wall')
const SpaceProfiler = require('./profilers/space')
const { AgentExporter } = require('./exporters/agent')
const { FileExporter } = require('./exporters/file')
const { ConsoleLogger } = require('./loggers/console')

const profiler = process.env.AWS_LAMBDA_FUNCTION_NAME ? new ServerlessProfiler() : new Profiler()

module.exports = {
  profiler,
  AgentExporter,
  FileExporter,
  CpuProfiler,
  WallProfiler,
  SpaceProfiler,
  ConsoleLogger
}
