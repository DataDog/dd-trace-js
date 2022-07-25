'use strict'

const coalesce = require('koalas')
const fs = require('fs')
const os = require('os')
const { satisfies } = require('semver')
const { URL } = require('url')
const { FileExporter } = require('./exporters/file')
const { ConsoleLogger } = require('./loggers/console')
const CpuProfiler = require('./profilers/cpu')
const WallProfiler = require('./profilers/wall')
const SpaceProfiler = require('./profilers/space')
const { tagger } = require('./tagger')

const { AgentExporter } = satisfies(process.version.slice(1), '>= 16.8')
  ? require('./exporters/agent-v16')
  : require('./exporters/agent')

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
  DD_PROFILING_UPLOAD_TIMEOUT,
  DD_PROFILING_SOURCE_MAP
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
    const sourceMap = coalesce(options.sourceMap,
      DD_PROFILING_SOURCE_MAP, true)

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
    this.sourceMap = sourceMap

    const hostname = coalesce(options.hostname, DD_AGENT_HOST, 'localhost')
    const port = coalesce(options.port, DD_TRACE_AGENT_PORT, 8126)
    this.url = getAgentUrl(coalesce(options.url, DD_TRACE_AGENT_URL,
      `http://${hostname || 'localhost'}:${port || 8126}`), options)

    this.exporters = ensureExporters(options.exporters || [
      new AgentExporter(this)
    ], this)

    const profilers = coalesce(options.profilers, DD_PROFILING_PROFILERS, [
      new WallProfiler(),
      new SpaceProfiler()
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

function getAgentUrl (url, options) {
  if (url) return new URL(url)

  if (os.type() === 'Windows_NT') return

  if (
    !options.hostname &&
    !options.port &&
    !process.env.DD_AGENT_HOST &&
    !process.env.DD_TRACE_AGENT_HOSTNAME &&
    !process.env.DD_TRACE_AGENT_PORT &&
    fs.existsSync('/var/run/datadog/apm.socket')
  ) {
    return new URL('unix:///var/run/datadog/apm.socket')
  }
}
