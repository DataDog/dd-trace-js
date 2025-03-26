'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { HEADER_INJECTION } = require('../vulnerabilities')
const { getNodeModulesPaths } = require('../path-line')
const { HEADER_NAME_VALUE_SEPARATOR } = require('../vulnerabilities-formatter/constants')
const { getRanges } = require('../taint-tracking/operations')
const {
  HTTP_REQUEST_COOKIE_VALUE,
  HTTP_REQUEST_HEADER_VALUE
} = require('../taint-tracking/source-types')

const EXCLUDED_PATHS = getNodeModulesPaths('express')
const EXCLUDED_HEADER_NAMES = [
  'location',
  'sec-websocket-location',
  'sec-websocket-accept',
  'upgrade',
  'connection'
]

class HeaderInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(HEADER_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:http:server:response:set-header:finish', ({ name, value }) => {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const headerValue = value[i]

          this.analyze({ name, value: headerValue })
        }
      } else {
        this.analyze({ name, value })
      }
    })
  }

  _isVulnerable ({ name, value }, iastContext) {
    const lowerCasedHeaderName = name?.trim().toLowerCase()

    if (this.isExcludedHeaderName(lowerCasedHeaderName) || typeof value !== 'string') return

    const ranges = getRanges(iastContext, value)
    return ranges?.length > 0 && !this.shouldIgnoreHeader(lowerCasedHeaderName, ranges)
  }

  _getEvidence (headerInfo, iastContext) {
    const prefix = headerInfo.name + HEADER_NAME_VALUE_SEPARATOR
    const prefixLength = prefix.length

    const evidence = super._getEvidence(headerInfo.value, iastContext)
    evidence.value = prefix + evidence.value
    evidence.ranges = evidence.ranges.map(range => {
      return {
        ...range,
        start: range.start + prefixLength,
        end: range.end + prefixLength
      }
    })

    return evidence
  }

  isExcludedHeaderName (name) {
    return EXCLUDED_HEADER_NAMES.includes(name)
  }

  isAllRangesFromHeader (ranges, headerName) {
    return ranges
      .every(range =>
        range.iinfo.type === HTTP_REQUEST_HEADER_VALUE && range.iinfo.parameterName?.toLowerCase() === headerName
      )
  }

  isAllRangesFromSource (ranges, source) {
    return ranges
      .every(range => range.iinfo.type === source)
  }

  /**
   * Exclude access-control-allow-*: when the header starts with access-control-allow- and the
   * source of the tainted range is a request header
   */
  isAccessControlAllowExclusion (name, ranges) {
    if (name?.startsWith('access-control-allow-')) {
      return this.isAllRangesFromSource(ranges, HTTP_REQUEST_HEADER_VALUE)
    }

    return false
  }

  /** Exclude when the header is reflected from the request */
  isSameHeaderExclusion (name, ranges) {
    return ranges.length === 1 && name === ranges[0].iinfo.parameterName?.toLowerCase()
  }

  shouldIgnoreHeader (headerName, ranges) {
    switch (headerName) {
      case 'set-cookie':
        /** Exclude set-cookie header if the source of all the tainted ranges are cookies */
        return this.isAllRangesFromSource(ranges, HTTP_REQUEST_COOKIE_VALUE)
      case 'pragma':
        /** Ignore pragma headers when the source is the cache control header. */
        return this.isAllRangesFromHeader(ranges, 'cache-control')
      case 'transfer-encoding':
      case 'content-encoding':
        /** Ignore transfer and content encoding headers when the source is the accept encoding header. */
        return this.isAllRangesFromHeader(ranges, 'accept-encoding')
    }

    return this.isAccessControlAllowExclusion(headerName, ranges) || this.isSameHeaderExclusion(headerName, ranges)
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }
}

module.exports = new HeaderInjectionAnalyzer()
