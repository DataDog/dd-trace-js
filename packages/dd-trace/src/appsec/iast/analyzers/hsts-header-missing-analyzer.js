'use strict'

const { HSTS_HEADER_MISSING } = require('../vulnerabilities')
const { MissingHeaderAnalyzer } = require('./missing-header-analyzer')

const HSTS_HEADER_NAME = 'Strict-Transport-Security'
const HEADER_VALID_PREFIX = 'max-age'
class HstsHeaderMissingAnalyzer extends MissingHeaderAnalyzer {
  constructor () {
    super(HSTS_HEADER_MISSING, HSTS_HEADER_NAME)
  }
  _isVulnerableFromRequestAndResponse (req, res) {
    const headerToCheck = res.getHeader(HSTS_HEADER_NAME)
    return !this._isHeaderValid(headerToCheck) && this._isHttpsProtocol(req)
  }

  _isHeaderValid (headerValue) {
    if (!headerValue) {
      return false
    }
    headerValue = headerValue.trim()

    if (!headerValue.startsWith(HEADER_VALID_PREFIX)) {
      return false
    }

    const semicolonIndex = headerValue.indexOf(';')
    let timestampString
    if (semicolonIndex > -1) {
      timestampString = headerValue.substring(HEADER_VALID_PREFIX.length + 1, semicolonIndex)
    } else {
      timestampString = headerValue.substring(HEADER_VALID_PREFIX.length + 1)
    }

    const timestamp = parseInt(timestampString)
    // eslint-disable-next-line eqeqeq
    return timestamp == timestampString && timestamp > 0
  }

  _isHttpsProtocol (req) {
    return req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
  }
}

module.exports = new HstsHeaderMissingAnalyzer()
