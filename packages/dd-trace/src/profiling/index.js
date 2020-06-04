'use strict'

const { Profiler } = require('./profiler')
const { InspectorCpuProfiler } = require('./profilers/inspector/cpu')
const { InspectorHeapProfiler } = require('./profilers/inspector/heap')
const { NativeCpuProfiler } = require('./profilers/native/cpu')
const { NativeHeapProfiler } = require('./profilers/native/heap')
const { AgentExporter } = require('./exporters/agent')
const { FileExporter } = require('./exporters/file')
const { ConsoleExporter } = require('./exporters/console')
const { ConsoleLogger } = require('./loggers/console')
const { CompositeLogger } = require('./loggers/composite')

const profiler = new Profiler()

module.exports = {
  profiler,
  AgentExporter,
  FileExporter,
  ConsoleExporter,
  InspectorCpuProfiler,
  InspectorHeapProfiler,
  NativeCpuProfiler,
  NativeHeapProfiler,
  ConsoleLogger,
  CompositeLogger
}
