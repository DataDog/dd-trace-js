'use strict'

const Analyzer = require('./vulnerability-analyzer')
const { INSECURE_COOKIE } = require('../vulnerabilities')

const EXCLUDED_PATHS = ['node_modules/express/lib/response.js', 'node_modules\\express\\lib\\response.js']

class InsecureCookieAnalyzer extends Analyzer {
  constructor () {
    super(INSECURE_COOKIE)
    this.addSub('datadog:iast:set-cookie', (cookieInfo) => this.analyze(cookieInfo))
  }

  _isVulnerable ({ cookieProperties, cookieValue }) {
    return cookieValue && !(cookieProperties && cookieProperties.map(x => x.toLowerCase().trim()).includes('secure'))
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
}

module.exports = new InsecureCookieAnalyzer()
