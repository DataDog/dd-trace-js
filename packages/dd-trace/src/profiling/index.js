'use strict'

const { Profiler } = require('./profiler')
const { InspectorCpuProfiler } = require('./profilers/inspector/cpu')
const { InspectorHeapProfiler } = require('./profilers/inspector/heap')
const { NativeCpuProfiler } = require('./profilers/native/cpu')
const { NativeHeapProfiler } = require('./profilers/native/heap')
const { AgentExporter } = require('./exporters/agent')
const { FileExporter } = require('./exporters/file')
const { ConsoleLogger } = require('./loggers/console')

const profiler = new Profiler()

module.exports = {
  profiler,
  AgentExporter,
  FileExporter,
  InspectorCpuProfiler,
  InspectorHeapProfiler,
  NativeCpuProfiler,
  NativeHeapProfiler,
  ConsoleLogger
}
