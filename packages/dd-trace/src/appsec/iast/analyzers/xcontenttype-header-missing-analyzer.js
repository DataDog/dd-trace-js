'use strict'

const { XCONTENTTYPE_HEADER_MISSING } = require('../vulnerabilities')
const { MissingHeaderAnalyzer } = require('./missing-header-analyzer')

const XCONTENTTYPEOPTIONS_HEADER_NAME = 'X-Content-Type-Options'

class XcontenttypeHeaderMissingAnalyzer extends MissingHeaderAnalyzer {
  constructor () {
    super(XCONTENTTYPE_HEADER_MISSING, XCONTENTTYPEOPTIONS_HEADER_NAME)
  }

  _isVulnerableFromRequestAndResponse (req, res) {
    const headerToCheck = res.getHeader(XCONTENTTYPEOPTIONS_HEADER_NAME)
    return !headerToCheck || headerToCheck.trim().toLowerCase() !== 'nosniff'
  }
}

module.exports = new XcontenttypeHeaderMissingAnalyzer()
