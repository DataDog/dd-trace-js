'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { UNVALIDATED_REDIRECT } = require('../vulnerabilities')
const { getNodeModulesPaths } = require('../path-line')
const { getRanges } = require('../taint-tracking/operations')
const { HTTP_REQUEST_HEADER_VALUE } = require('../taint-tracking/source-types')

const EXCLUDED_PATHS = getNodeModulesPaths('express/lib/response.js')

class UnvalidatedRedirectAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(UNVALIDATED_REDIRECT)
  }

  onConfigure () {
    this.addSub('datadog:http:server:response:set-header:finish', ({ name, value }) => this.analyze(name, value))
  }

  // TODO: In case the location header value is tainted, this analyzer should check the ranges of the tainted.
  // And do not report a vulnerability if source of the ranges (range.iinfo.type) are exclusively url or path params
  // to avoid false positives.
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
    return ranges && ranges.length > 0 && !this._isRefererHeader(ranges)
  }

  _isRefererHeader (ranges) {
    return ranges && ranges.every(range => range.iinfo.type === HTTP_REQUEST_HEADER_VALUE &&
      range.iinfo.parameterName && range.iinfo.parameterName.toLowerCase() === 'referer')
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }
}

module.exports = new UnvalidatedRedirectAnalyzer()
