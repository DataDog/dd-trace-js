'use strict'

const { existsSync } = require('fs')
const { addTags, parseTags } = require('./util')
const pkg = require('./pkg')

const env = process.env

const DD_SERVICE = env.DD_SERVICE || env.DD_SERVICE_NAME || env.AWS_LAMBDA_FUNCTION_NAME
const DD_ENV = env.DD_ENV
const DD_VERSION = env.DD_VERSION
const DD_TRACE_SAMPLE_RATE = env.DD_TRACE_SAMPLE_RATE
const DD_TRACE_RATE_LIMIT = env.DD_TRACE_RATE_LIMIT
const DD_TRACE_AGENT_URL = env.DD_TRACE_AGENT_URL || env.DD_TRACE_URL
const DD_TRACE_AGENT_HOSTNAME = env.DD_AGENT_HOST || env.DD_TRACE_AGENT_HOSTNAME
const DD_TRACE_AGENT_PORT = env.DD_TRACE_AGENT_PORT
const DD_TRACE_AGENT_PROTOCOL_VERSION = env.DD_TRACE_AGENT_PROTOCOL_VERSION

class Config {
  constructor (options) {
    this.service = DD_SERVICE || pkg.name || 'node'
    this.env = DD_ENV
    this.version = DD_VERSION
    this.protocolVersion = DD_TRACE_AGENT_PROTOCOL_VERSION || '0.4'
    this.exporter = env.AWS_LAMBDA_FUNCTION_NAME ? 'log' : 'agent'
    this.sampleRate = DD_TRACE_SAMPLE_RATE && parseInt(DD_TRACE_SAMPLE_RATE)
    this.rateLimit = DD_TRACE_RATE_LIMIT ? parseInt(DD_TRACE_RATE_LIMIT) : 100
    this.flushInterval = 2000
    this.meta = {}
    this.metrics = {}
    this.url = this._getUrl(
      DD_TRACE_AGENT_URL,
      DD_TRACE_AGENT_HOSTNAME,
      DD_TRACE_AGENT_PORT
    )

    parseTags(this, env.DD_TAGS)
    parseTags(this, env.DD_TRACE_TAGS)
    parseTags(this, env.DD_TRACE_GLOBAL_TAGS)

    this.update(options)
  }

  update (options = {}) {
    this.service = options.service || (options.tags && options.tags.service) || this.service
    this.env = options.env || this.env
    this.version = options.version || this.version
    this.protocolVersion = options.protocolVersion || this.protocolVersion
    this.sampleRate = typeof options.sampleRate === 'number'
      ? options.sampleRate
      : this.sampleRate
    this.rateLimit = typeof options.rateLimit === 'number'
      ? options.rateLimit
      : this.rateLimit
    this.flushInterval = typeof options.flushInterval === 'number'
      ? options.flushInterval
      : this.flushInterval
    this.url = this._getUrl(options.url, options.hostname, options.port)

    addTags(this, options.tags)
  }

  _getUrl (url, hostname, port) {
    try {
      if (hostname || port) {
        return new URL(`http://${hostname || '127.0.0.1'}:${port || 8126}`)
      } else if (url) {
        return new URL(url)
      } else if (existsSync('/var/run/datadog/apm.socket')) {
        return new URL('file:///var/run/datadog/apm.socket')
      }
    } catch (e) {
      // ignore error and fallback to default return value
    }

    return this.url || new URL('http://127.0.0.1:8126')
  }
}

module.exports = { Config }
