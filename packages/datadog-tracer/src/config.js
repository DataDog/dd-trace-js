'use strict'

const { addTags, parseTags } = require('./util')
const pkg = require('./pkg')

const env = process.env

const DD_SERVICE = env.DD_SERVICE || env.DD_SERVICE_NAME || env.AWS_LAMBDA_FUNCTION_NAME
const DD_ENV = env.DD_ENV
const DD_VERSION = env.DD_VERSION
const DD_TRACE_SAMPLE_RATE = env.DD_TRACE_SAMPLE_RATE
const DD_TRACE_RATE_LIMIT = env.DD_TRACE_RATE_LIMIT

class Config {
  constructor (options) {
    this.service = DD_SERVICE || pkg.name || 'node'
    this.env = DD_ENV
    this.version = DD_VERSION
    this.sampleRate = DD_TRACE_SAMPLE_RATE && parseInt(DD_TRACE_SAMPLE_RATE)
    this.rateLimit = DD_TRACE_RATE_LIMIT ? parseInt(DD_TRACE_RATE_LIMIT) : 100
    this.meta = {}
    this.metrics = {}
    this.url = new URL('http://localhost:8126')

    parseTags(this, env.DD_TAGS)
    parseTags(this, env.DD_TRACE_TAGS)
    parseTags(this, env.DD_TRACE_GLOBAL_TAGS)

    this.update(options)
  }

  update (options = {}) {
    this.service = options.service || this.service
    this.env = options.env || this.env
    this.version = options.version || this.version
    this.sampleRate = typeof options.sampleRate === 'number'
      ? options.sampleRate
      : this.sampleRate
    this.rateLimit = typeof options.rateLimit === 'number'
      ? options.rateLimit
      : this.rateLimit

    addTags(this, options.tags)
  }
}

module.exports = { Config }
