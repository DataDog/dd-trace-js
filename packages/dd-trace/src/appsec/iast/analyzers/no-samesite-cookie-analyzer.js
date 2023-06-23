'use strict'

const { NO_SAMESITE_COOKIE } = require('../vulnerabilities')
const CookieAnalyzer = require('./cookie-analyzer')

class NoSamesiteCookieAnalyzer extends CookieAnalyzer {
  constructor () {
    super(NO_SAMESITE_COOKIE, 'SameSite=strict')
  }
}

module.exports = new NoSamesiteCookieAnalyzer()
