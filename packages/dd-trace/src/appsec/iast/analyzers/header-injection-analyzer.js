'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { HEADER_INJECTION } = require('../vulnerabilities')
const { getNodeModulesPaths } = require('../path-line')
const { HEADER_NAME_VALUE_SEPARATOR } = require('../vulnerabilities-formatter/constants')

const EXCLUDED_PATHS = getNodeModulesPaths('express')

class HeaderInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(HEADER_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:http:server:response:set-header:finish', ({ name, value }) => this.analyze({ name, value }))
  }

  analyze (headerInfo) {
    const { name, value } = headerInfo

    if (this.isLocationHeader(name) || typeof value !== 'string') return

    super.analyze(headerInfo)
  }

  _isVulnerable ({ value }, iastContext) {
    return super._isVulnerable(value, iastContext)
  }

  _getEvidence (headerInfo, iastContext) {
    const prefix = headerInfo.name + HEADER_NAME_VALUE_SEPARATOR

    const evidence = super._getEvidence(headerInfo.value, iastContext)
    evidence.value = prefix + evidence.value
    evidence.ranges = evidence.ranges.map(range => {
      return {
        ...range,
        start: range.start + prefix.length,
        end: range.end + prefix.length
      }
    })

    return evidence
  }

  isLocationHeader (name) {
    return name?.trim().toLowerCase() === 'location'
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }
}

module.exports = new HeaderInjectionAnalyzer()
module.exports.HEADER_NAME_VALUE_SEPARATOR = HEADER_NAME_VALUE_SEPARATOR
