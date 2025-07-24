'use strict'

const { HSTS_HEADER_MISSING } = require('../vulnerabilities')
const { MissingHeaderAnalyzer } = require('./missing-header-analyzer')

const HSTS_HEADER_NAME = 'Strict-Transport-Security'
const HEADER_VALID_PREFIX = 'max-age'
class HstsHeaderMissingAnalyzer extends MissingHeaderAnalyzer {
  constructor () {
    super(HSTS_HEADER_MISSING, HSTS_HEADER_NAME)
  }

  _isVulnerableFromRequestAndResponse (req, res, storedHeaders) {
    const headerValues = this._getHeaderValues(res, storedHeaders, HSTS_HEADER_NAME)
    return this._isHttpsProtocol(req) && (
      headerValues.length === 0 ||
      headerValues.some(headerValue => !this._isHeaderValid(headerValue))
    )
  }

  _isHeaderValid (headerValue) {
    headerValue = headerValue.trim()

    if (!headerValue?.startsWith(HEADER_VALID_PREFIX)) {
      return false
    }

    const semicolonIndex = headerValue.indexOf(';')
    const timestampString = headerValue.slice(
      HEADER_VALID_PREFIX.length + 1,
      semicolonIndex === -1 ? headerValue.length : semicolonIndex
    )

    const timestamp = Number.parseInt(timestampString)
    // eslint-disable-next-line eqeqeq
    return timestamp > 0 && timestamp == timestampString
  }

  _isHttpsProtocol (req) {
    return req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
  }
}

module.exports = new HstsHeaderMissingAnalyzer()
