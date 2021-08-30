'use strict'

const { coalesce } = require('../util')
const os = require('os')
const { URL } = require('url')
const { AgentExporter } = require('./exporters/agent')
const { FileExporter } = require('./exporters/file')
const { ConsoleLogger } = require('./loggers/console')
const CpuProfiler = require('./profilers/cpu')
const HeapProfiler = require('./profilers/heap')
const { tagger } = require('./tagger')

const {
  DD_PROFILING_ENABLED,
  DD_PROFILING_PROFILERS,
  DD_ENV,
  DD_TAGS,
  DD_SERVICE,
  DD_VERSION,
  DD_TRACE_AGENT_URL,
  DD_AGENT_HOST,
  DD_TRACE_AGENT_PORT,
  DD_PROFILING_UPLOAD_TIMEOUT
} = process.env

class Config {
  constructor (options = {}) {
    const enabled = coalesce(options.enabled, DD_PROFILING_ENABLED, true)
    const env = coalesce(options.env, DD_ENV)
    const service = options.service || DD_SERVICE || 'node'
    const host = os.hostname()
    const version = coalesce(options.version, DD_VERSION)
    // Must be longer than one minute so pad with five seconds
    const flushInterval = coalesce(options.interval, 65 * 1000)
    const uploadTimeout = coalesce(options.uploadTimeout,
      DD_PROFILING_UPLOAD_TIMEOUT, 60 * 1000)

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
    this.logger = ensureLogger(options.logger)
    this.flushInterval = flushInterval
    this.uploadTimeout = uploadTimeout

    const hostname = coalesce(options.hostname, DD_AGENT_HOST, 'localhost')
    const port = coalesce(options.port, DD_TRACE_AGENT_PORT, 8126)
    this.url = new URL(coalesce(options.url, DD_TRACE_AGENT_URL,
      `http://${hostname || 'localhost'}:${port || 8126}`))

    this.exporters = ensureExporters(options.exporters || [
      new AgentExporter(this)
    ], this)

    const profilers = coalesce(options.profilers, DD_PROFILING_PROFILERS, [
      new CpuProfiler(),
      new HeapProfiler()
    ])

    this.profilers = ensureProfilers(profilers, this)
  }
}

module.exports = { Config }

function getExporter (name, options) {
  switch (name) {
    case 'agent':
      return new AgentExporter(options)
    case 'file':
      return new FileExporter(options)
  }
}

function ensureExporters (exporters, options) {
  if (typeof exporters === 'string') {
    exporters = exporters.split(',')
  }

  for (let i = 0; i < exporters.length; i++) {
    const exporter = exporters[i]
    if (typeof exporter === 'string') {
      exporters[i] = getExporter(exporter, options)
    }
  }

  return exporters
}

function getProfiler (name, options) {
  switch (name) {
    case 'cpu':
      return new CpuProfiler(options)
    case 'heap':
      return new HeapProfiler(options)
    default:
      options.logger.error(`Unknown profiler "${name}"`)
  }
}

function ensureProfilers (profilers, options) {
  if (typeof profilers === 'string') {
    profilers = profilers.split(',')
  }

  for (let i = 0; i < profilers.length; i++) {
    const profiler = profilers[i]
    if (typeof profiler === 'string') {
      profilers[i] = getProfiler(profiler, options)
    }
  }

  // Filter out any invalid profilers
  return profilers.filter(v => v)
}

function ensureLogger (logger) {
  if (typeof logger !== 'object' ||
    typeof logger.debug !== 'function' ||
    typeof logger.info !== 'function' ||
    typeof logger.warn !== 'function' ||
    typeof logger.error !== 'function') {
    return new ConsoleLogger()
  }

  return logger
}
