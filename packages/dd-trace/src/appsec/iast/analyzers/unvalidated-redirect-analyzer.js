'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { UNVALIDATED_REDIRECT } = require('../vulnerabilities')
const { getNodeModulesPaths } = require('../path-line')
const { getRanges } = require('../taint-tracking/operations')
const {
  HTTP_REQUEST_BODY,
  HTTP_REQUEST_PARAMETER
} = require('../taint-tracking/source-types')

const EXCLUDED_PATHS = [
  getNodeModulesPaths('express/lib/response.js'),
  getNodeModulesPaths('fastify/lib/reply.js'),
]

const VULNERABLE_SOURCE_TYPES = new Set([
  HTTP_REQUEST_BODY,
  HTTP_REQUEST_PARAMETER
])

class UnvalidatedRedirectAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(UNVALIDATED_REDIRECT)
  }

  onConfigure () {
    this.addSub('datadog:http:server:response:set-header:finish', ({ name, value }) => this.analyze(name, value))
    this.addSub('datadog:fastify:set-header:finish', ({ name, value }) => this.analyze(name, value))
  }

  analyze (name, value) {
    if (!this.isLocationHeader(name) || typeof value !== 'string') return

    super.analyze(value)
  }

  isLocationHeader (name) {
    return name && name.trim().toLowerCase() === 'location'
  }

  _isVulnerable (value, iastContext) {
    if (!value) return false

    const ranges = getRanges(iastContext, value)
    return ranges?.length > 0 && this._hasUnsafeRange(ranges)
  }

  _hasUnsafeRange (ranges) {
    return ranges.some(
      range => this._isVulnerableRange(range)
    )
  }

  _isVulnerableRange (range) {
    return VULNERABLE_SOURCE_TYPES.has(range.iinfo.type)
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }
}

module.exports = new UnvalidatedRedirectAnalyzer()
