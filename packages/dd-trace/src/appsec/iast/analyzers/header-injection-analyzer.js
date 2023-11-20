'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { HEADER_INJECTION } = require('../vulnerabilities')
const { getNodeModulesPaths } = require('../path-line')

const EXCLUDED_PATHS = getNodeModulesPaths('express/lib/response.js')

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
    const evidence = super._getEvidence(headerInfo.value, iastContext)

    evidence.context = {
      headerName: headerInfo.name
    }

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
