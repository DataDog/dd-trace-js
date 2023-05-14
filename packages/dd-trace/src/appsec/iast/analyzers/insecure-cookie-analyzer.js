'use strict'

const Analyzer = require('./vulnerability-analyzer')
const { INSECURE_COOKIE } = require('../vulnerabilities')
class InsecureCookieAnalyzer extends Analyzer {
  constructor () {
    super(INSECURE_COOKIE)
  }

  _getLocation (value, context) {
    return { url: context.req.url }
  }

  _isVulnerable (res, context) {
    if (res) {
      let cookies = res.getHeader('set-cookie')
      if (cookies) {
        if (typeof cookies === 'string') {
          cookies = [cookies]
        }
        if (Array.isArray(cookies)) {
          const vulnerableCookies = []
          for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i]
            if (typeof cookie === 'string') {
              if (cookie.toLowerCase().indexOf('; secure') === -1) {
                vulnerableCookies.push(cookie)
              }
            }
          }
          if (vulnerableCookies.length > 0) {
            context.vulnerableCookies = vulnerableCookies
            return true
          }
        }
      }
    }
    return false
  }
  _getHashExtension (value) {
    return value
  }
  _getEvidence (value, context) {
    return { value }
  }

  _report (value, context) {
    if (Array.isArray(context.vulnerableCookies)) {
      context.vulnerableCookies.forEach(insecureCookie => {
        super._report(insecureCookie.split('=')[0], context)
      })
    }
  }
}

module.exports = new InsecureCookieAnalyzer()
