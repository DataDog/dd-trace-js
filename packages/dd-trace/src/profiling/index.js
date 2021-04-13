'use strict'

const { Profiler } = require('./profiler')
const CpuProfiler = require('./profilers/cpu')
const HeapProfiler = require('./profilers/heap')
const { AgentExporter } = require('./exporters/agent')
const { FileExporter } = require('./exporters/file')
const { ConsoleLogger } = require('./loggers/console')

const profiler = new Profiler()

module.exports = {
  profiler,
  AgentExporter,
  FileExporter,
  CpuProfiler,
  HeapProfiler,
  ConsoleLogger
}
