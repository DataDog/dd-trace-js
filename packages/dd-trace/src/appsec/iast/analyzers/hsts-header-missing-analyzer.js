'use strict'

const { HSTS_HEADER_MISSING } = require('../vulnerabilities')
const { MissingHeaderAnalyzer } = require('./missing-header-analyzer')

const HSTS_HEADER_NAME = 'Strict-Transport-Security'

class HstsHeaderMissingAnalyzer extends MissingHeaderAnalyzer {
  constructor () {
    super(HSTS_HEADER_MISSING, HSTS_HEADER_NAME)
  }
  _validateRequestAndResponse (req, res) {
    const headerToCheck = res.getHeader(HSTS_HEADER_NAME)
    return !headerToCheck && this._isHttpsProtocol(req)
  }

  _isHttpsProtocol (req) {
    return req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
  }
}

module.exports = new HstsHeaderMissingAnalyzer()
