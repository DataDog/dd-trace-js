'use strict'

const Analyzer = require('./vulnerability-analyzer')
const { getNodeModulesPaths } = require('../path-line')

const EXCLUDED_PATHS = [
  // Express
  getNodeModulesPaths('express/lib/response.js'),
  // Fastify
  getNodeModulesPaths('fastify/lib/reply.js'),
  getNodeModulesPaths('fastify/lib/hooks.js'),
  getNodeModulesPaths('@fastify/cookie/plugin.js')
]

class CookieAnalyzer extends Analyzer {
  constructor (type, propertyToBeSafe) {
    super(type)
    this.propertyToBeSafe = propertyToBeSafe.toLowerCase()
  }

  onConfigure () {
    this.addSub(
      { channelName: 'datadog:iast:set-cookie', moduleName: 'http' },
      (cookieInfo) => this.analyze(cookieInfo)
    )
  }

  _isVulnerable ({ cookieProperties, cookieValue }) {
    return cookieValue && !(cookieProperties && cookieProperties
      .map(x => x.toLowerCase().trim()).includes(this.propertyToBeSafe))
  }

  _getEvidence ({ cookieName }) {
    return { value: cookieName }
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }

  _checkOCE (context, value) {
    if (value && value.location) {
      return true
    }
    return super._checkOCE(context, value)
  }

  _getLocation (value, callSiteFrames) {
    if (!value) {
      return super._getLocation(value, callSiteFrames)
    }

    if (value.location) {
      return value.location
    }
    const location = super._getLocation(value, callSiteFrames)
    value.location = location
    return location
  }
}

module.exports = CookieAnalyzer
