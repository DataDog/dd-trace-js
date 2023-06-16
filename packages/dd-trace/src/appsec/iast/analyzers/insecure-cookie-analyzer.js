'use strict'

const { INSECURE_COOKIE } = require('../vulnerabilities')
const CookieAnalyzer = require('./cookie-analyzer')

class InsecureCookieAnalyzer extends CookieAnalyzer {
  constructor () {
    super(INSECURE_COOKIE, 'secure')
  }
}

module.exports = new InsecureCookieAnalyzer()
