'use strict'

const { XCONTENTTYPE_HEADER_MISSING } = require('../vulnerabilities')
const { MissingHeaderAnalyzer } = require('./missing-header-analyzer')

const XCONTENTTYPEOPTIONS_HEADER_NAME = 'X-Content-Type-Options'

class XcontenttypeHeaderMissingAnalyzer extends MissingHeaderAnalyzer {
  constructor () {
    super(XCONTENTTYPE_HEADER_MISSING, XCONTENTTYPEOPTIONS_HEADER_NAME)
  }

  _isVulnerableFromRequestAndResponse (req, res, storedHeaders) {
    const headerValues = this._getHeaderValues(res, storedHeaders, XCONTENTTYPEOPTIONS_HEADER_NAME)
    return headerValues.length === 0 || headerValues.some(headerValue => headerValue.trim().toLowerCase() !== 'nosniff')
  }
}

module.exports = new XcontenttypeHeaderMissingAnalyzer()
