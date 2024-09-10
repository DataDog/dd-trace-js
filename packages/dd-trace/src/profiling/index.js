'use strict'

const { Profiler } = require('./profiler')
const WallProfiler = require('./profilers/wall')
const SpaceProfiler = require('./profilers/space')
const { AgentExporter } = require('./exporters/agent')
const { FileExporter } = require('./exporters/file')
const { ConsoleLogger } = require('./loggers/console')

const profiler = new Profiler()

module.exports = {
  profiler,
  AgentExporter,
  FileExporter,
  WallProfiler,
  SpaceProfiler,
  ConsoleLogger
}
