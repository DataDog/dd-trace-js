'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { HEADER_INJECTION } = require('../vulnerabilities')
const { getNodeModulesPaths } = require('../path-line')
const { HEADER_NAME_VALUE_SEPARATOR } = require('../vulnerabilities-formatter/constants')
const { getRanges } = require('../taint-tracking/operations')
const {
  HTTP_REQUEST_COOKIE_NAME,
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
    if (ranges?.length > 0) {
      return !(this.isCookieExclusion(lowerCasedHeaderName, ranges) ||
        this.isSameHeaderExclusion(lowerCasedHeaderName, ranges) ||
        this.isAccessControlAllowExclusion(lowerCasedHeaderName, ranges))
    }

    return false
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

  isCookieExclusion (name, ranges) {
    if (name === 'set-cookie') {
      return ranges
        .every(range => range.iinfo.type === HTTP_REQUEST_COOKIE_VALUE || range.iinfo.type === HTTP_REQUEST_COOKIE_NAME)
    }

    return false
  }

  isAccessControlAllowExclusion (name, ranges) {
    if (name?.startsWith('access-control-allow-')) {
      return ranges
        .every(range => range.iinfo.type === HTTP_REQUEST_HEADER_VALUE)
    }

    return false
  }

  isSameHeaderExclusion (name, ranges) {
    return ranges.length === 1 && name === ranges[0].iinfo.parameterName?.toLowerCase()
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }
}

module.exports = new HeaderInjectionAnalyzer()
