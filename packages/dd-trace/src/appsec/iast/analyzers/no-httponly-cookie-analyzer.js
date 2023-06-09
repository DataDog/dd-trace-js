'use strict'

const { NO_HTTP_ONLY_COOKIE } = require('../vulnerabilities')
const CookieAnalyzer = require('./cookie-analyzer')

class NoHttponlyCookieAnalyzer extends CookieAnalyzer {
  constructor () {
    super(NO_HTTP_ONLY_COOKIE, 'HttpOnly')
  }
}

module.exports = new NoHttponlyCookieAnalyzer()
