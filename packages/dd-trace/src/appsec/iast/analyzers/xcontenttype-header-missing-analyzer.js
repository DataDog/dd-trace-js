'use strict'

const Analyzer = require('./vulnerability-analyzer')
const { XCONTENTTYPE_HEADER_MISSING } = require('../vulnerabilities')

const htmlContentTypes = ['text/html', 'application/xhtml+xml']
function isResponseHtml (res) {
  const contentType = res.getHeader('content-type')
  return contentType && htmlContentTypes.some(htmlContentType => {
    return htmlContentType === contentType || contentType.indexOf(htmlContentType + ';') === 0
  })
}

const XCONTENTTYPEOPTIONS_HEADER_NAME = 'X-Content-Type-Options'

const SC_MOVED_PERMANENTLY = 301
const SC_MOVED_TEMPORARILY = 302
const SC_NOT_MODIFIED = 304
const SC_TEMPORARY_REDIRECT = 307
const SC_NOT_FOUND = 404
const SC_GONE = 410
const SC_INTERNAL_SERVER_ERROR = 500

const IGNORED_RESPONSE_STATUS_LIST = [SC_MOVED_PERMANENTLY, SC_MOVED_TEMPORARILY, SC_NOT_MODIFIED,
  SC_TEMPORARY_REDIRECT, SC_NOT_FOUND, SC_GONE, SC_INTERNAL_SERVER_ERROR]
class XcontenttypeHeaderMissingAnalyzer extends Analyzer {
  constructor () {
    super(XCONTENTTYPE_HEADER_MISSING)

    this.addSub('datadog:iast:response-end', (data) => this.analyze(data))
  }

  _isVulnerable ({ req, res }, context) {
    // TODO check response status
    if (!IGNORED_RESPONSE_STATUS_LIST.includes(res.statusCode) && isResponseHtml(res)) {
      const headerToCheck = res.getHeader(XCONTENTTYPEOPTIONS_HEADER_NAME)
      return !headerToCheck || headerToCheck.trim().toLowerCase() !== 'nosniff'
    }
    return false
  }

  _getEvidence ({ res }) {
    return { value: res.getHeader(XCONTENTTYPEOPTIONS_HEADER_NAME) }
  }

  _getLocation () {
    return undefined
  }

  _checkOCE (context) {
    return true
  }

  _createHashSource (type, evidence, location) {
    return `${type}:${this.config.tracerConfig.service}`
  }
}

module.exports = new XcontenttypeHeaderMissingAnalyzer()
