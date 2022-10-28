'use strict'

const coalesce = require('koalas')
const os = require('os')
const { URL } = require('url')
const { AgentExporter } = require('./exporters/agent')
const { FileExporter } = require('./exporters/file')
const { ConsoleLogger } = require('./loggers/console')
const CpuProfiler = require('./profilers/cpu')
const WallProfiler = require('./profilers/wall')
const SpaceProfiler = require('./profilers/space')
const { tagger } = require('./tagger')

const {
  DD_PROFILING_ENABLED,
  DD_PROFILING_PROFILERS,
  DD_PROFILING_ENDPOINT_COLLECTION_ENABLED,
  DD_ENV,
  DD_TAGS,
  DD_SERVICE,
  DD_VERSION,
  DD_TRACE_AGENT_URL,
  DD_AGENT_HOST,
  DD_TRACE_AGENT_PORT,
  DD_PROFILING_UPLOAD_TIMEOUT,
  DD_PROFILING_SOURCE_MAP,
  AWS_LAMBDA_FUNCTION_NAME,
} = process.env

class Config {
  constructor (options = {}) {
    const enabled = coalesce(options.enabled, DD_PROFILING_ENABLED, true)
    const env = coalesce(options.env, DD_ENV)
    const service = options.service || DD_SERVICE || 'node'
    const host = os.hostname()
    const version = coalesce(options.version, DD_VERSION)
    const functionName = coalesce(options.functionName, AWS_LAMBDA_FUNCTION_NAME)
    // Must be longer than one minute so pad with five seconds
    // const flushInterval = coalesce(options.interval, 65 * 1000)
    const flushIntervalInSeconds = AWS_LAMBDA_FUNCTION_NAME ? 1 : 65 
    const flushInterval = coalesce(options.interval, flushIntervalInSeconds * 1000)
    const uploadTimeout = coalesce(options.uploadTimeout,
      DD_PROFILING_UPLOAD_TIMEOUT, 60 * 1000)
    const sourceMap = coalesce(options.sourceMap,
      DD_PROFILING_SOURCE_MAP, true)
    const endpointCollection = coalesce(options.endpointCollection,
      DD_PROFILING_ENDPOINT_COLLECTION_ENABLED, false)

    this.enabled = String(enabled) !== 'false'
    this.service = service
    this.env = env
    this.host = host
    this.functionName = functionName

    this.version = version
    console.log('[Amy:config] functionName:', this.functionName)
    this.tags = Object.assign(
      tagger.parse(DD_TAGS),
      tagger.parse(options.tags),
      tagger.parse({ env, host, service, version, functionName })
    )
    console.log('[Amy:config] this.tags:', this.tags)
    this.logger = ensureLogger(options.logger)
    this.flushInterval = flushInterval
    this.uploadTimeout = uploadTimeout
    this.sourceMap = sourceMap
    this.endpointCollection = endpointCollection

    const hostname = coalesce(options.hostname, DD_AGENT_HOST, 'localhost')
    const port = coalesce(options.port, DD_TRACE_AGENT_PORT, 8126)
    this.url = new URL(coalesce(options.url, DD_TRACE_AGENT_URL,
      `http://${hostname || 'localhost'}:${port || 8126}`))

    this.exporters = ensureExporters(options.exporters || [
      new AgentExporter(this)
    ], this)

    const profilers = coalesce(options.profilers, DD_PROFILING_PROFILERS, [
      new WallProfiler(this),
      new SpaceProfiler(this)
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
    case 'wall':
      return new WallProfiler(options)
    case 'space':
      return new SpaceProfiler(options)
    case 'cpu-experimental':
      return new CpuProfiler(options)
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
