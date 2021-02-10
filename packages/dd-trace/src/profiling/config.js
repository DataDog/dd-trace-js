'use strict'

const coalesce = require('koalas')
const os = require('os')
const { AgentExporter } = require('./exporters/agent')
const { InspectorCpuProfiler } = require('./profilers/inspector/cpu')
const { InspectorHeapProfiler } = require('./profilers/inspector/heap')
const { ConsoleLogger } = require('./loggers/console')
const { tagger } = require('./tagger')

const {
  DD_PROFILING_ENABLED,
  DD_ENV,
  DD_TAGS,
  DD_SERVICE,
  DD_VERSION
} = process.env

class Config {
  constructor (options = {}) {
    const enabled = coalesce(options.enabled, DD_PROFILING_ENABLED, true)
    const env = coalesce(options.env, DD_ENV)
    const service = options.service || DD_SERVICE || 'node'
    const host = os.hostname()
    const version = coalesce(options.version, DD_VERSION)
    const flushInterval = 60 * 1000

    this.enabled = String(enabled) !== 'false'
    this.service = service
    this.env = env
    this.host = host
    this.version = version
    this.tags = Object.assign(
      tagger.parse(DD_TAGS),
      tagger.parse(options.tags),
      tagger.parse({ env, host, service, version })
    )
    this.logger = options.logger || new ConsoleLogger()
    this.flushInterval = flushInterval
    this.exporters = options.exporters || [
      new AgentExporter()
    ]
    this.profilers = options.profilers || [
      new InspectorCpuProfiler(),
      new InspectorHeapProfiler()
    ]
  }
}

module.exports = { Config }
