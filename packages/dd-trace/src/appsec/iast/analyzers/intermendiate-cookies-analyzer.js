'use strict'

const Analyzer = require('./vulnerability-analyzer')
const dc = require('../../../../../diagnostics_channel')
const iastSetCookieChannel = dc.channel('datadog:iast:set-cookie')

class IntermediateCookiesAnalyzer extends Analyzer {
  constructor () {
    super()
    this.cookiesInRequest = new WeakMap()
    this.addSub('datadog:http:server:response:set-header:finish', ({ name, value, res }) => {
      if (name.toLowerCase() === 'set-cookie') {
        let allCookies = value
        if (typeof value === 'string') {
          allCookies = [value]
        }
        const alreadyCheckedCookies = this._getAlreadyCheckedCookiesInResponse(res)
        allCookies.forEach(cookieString => {
          if (!alreadyCheckedCookies.includes(cookieString)) {
            alreadyCheckedCookies.push(cookieString)
            iastSetCookieChannel.publish(this._parseCookie(cookieString))
          }
        })
      }
    })
  }

  _parseCookie (cookieString) {
    const cookieParts = cookieString.split(';')
    const nameValueParts = cookieParts[0].split('=')
    const cookieName = nameValueParts[0]
    const cookieValue = nameValueParts.slice(1).join('=')
    const cookieProperties = cookieParts.slice(1).map(part => part.trim())

    return { cookieName, cookieValue, cookieProperties, cookieString }
  }

  _getAlreadyCheckedCookiesInResponse (res) {
    let alreadyCheckedCookies = this.cookiesInRequest.get(res)
    if (!alreadyCheckedCookies) {
      alreadyCheckedCookies = []
      this.cookiesInRequest.set(res, alreadyCheckedCookies)
    }
    return alreadyCheckedCookies
  }
}

module.exports = new IntermediateCookiesAnalyzer()
