'use strict'

const { NO_HTTPONLY_COOKIE } = require('../vulnerabilities')
const CookieAnalyzer = require('./cookie-analyzer')

class NoHttponlyCookieAnalyzer extends CookieAnalyzer {
  constructor () {
    super(NO_HTTPONLY_COOKIE, 'HttpOnly')
  }
}

module.exports = new NoHttponlyCookieAnalyzer()
