'use strict'

const Analyzer = require('./vulnerability-analyzer')
const { getNodeModulesPaths } = require('../path-line')

const EXCLUDED_PATHS = getNodeModulesPaths('express/lib/response.js')

class CookieAnalyzer extends Analyzer {
  constructor (type, propertyToBeSafe) {
    super(type)
    this.propertyToBeSafe = propertyToBeSafe.toLowerCase()
    this.addSub('datadog:iast:set-cookie', (cookieInfo) => this.analyze(cookieInfo))
  }

  _isVulnerable ({ cookieProperties, cookieValue }) {
    return cookieValue && !(cookieProperties && cookieProperties
      .map(x => x.toLowerCase().trim()).includes(this.propertyToBeSafe))
  }

  _getEvidence ({ cookieName }) {
    return { value: cookieName }
  }

  _createHashSource (type, evidence, location) {
    return `${type}:${evidence.value}`
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }
  _checkOCE (context, value) {
    if (value && value.location) {
      return true
    }
    return super._checkOCE(context)
  }

  _getLocation (value, context) {
    if (value.location) {
      return value.location
    }
    const location = super._getLocation(value)
    value.location = location
    return location
  }
}

module.exports = CookieAnalyzer
