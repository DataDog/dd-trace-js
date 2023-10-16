'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { UNVALIDATED_REDIRECT } = require('../vulnerabilities')
const { getNodeModulesPaths } = require('../path-line')
const { getRanges } = require('../taint-tracking/operations')
const {
  HTTP_REQUEST_HEADER_VALUE,
  HTTP_REQUEST_PATH_PARAM,
  HTTP_REQUEST_URI
} = require('../taint-tracking/source-types')

const EXCLUDED_PATHS = getNodeModulesPaths('express/lib/response.js')

class UnvalidatedRedirectAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(UNVALIDATED_REDIRECT)
  }

  onConfigure () {
    this.addSub('datadog:http:server:response:set-header:finish', ({ name, value }) => this.analyze(name, value))
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
    return ranges && ranges.length > 0 && !this._areSafeRanges(ranges)
  }

  // Do not report vulnerability if ranges sources are exclusively url,
  // path params or referer header to avoid false positives.
  _areSafeRanges (ranges) {
    return ranges && ranges.every(
      range => this._isPathParam(range) || this._isUrl(range) || this._isRefererHeader(range)
    )
  }

  _isRefererHeader (range) {
    return range.iinfo.type === HTTP_REQUEST_HEADER_VALUE &&
      range.iinfo.parameterName && range.iinfo.parameterName.toLowerCase() === 'referer'
  }

  _isPathParam (range) {
    return range.iinfo.type === HTTP_REQUEST_PATH_PARAM
  }

  _isUrl (range) {
    return range.iinfo.type === HTTP_REQUEST_URI
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }
}

module.exports = new UnvalidatedRedirectAnalyzer()
