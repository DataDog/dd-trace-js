'use strict'

const Plugin = require('../../../plugins/plugin')
const { setCookieChannel } = require('../../channels')

class SetCookiesHeaderInterceptor extends Plugin {
  constructor () {
    super()
    this.cookiesInRequest = new WeakMap()

    this.addSub('datadog:http:server:response:set-header:finish',
      ({ name, value, res }) => this.#handleCookies(name, value, res))

    this.addSub('datadog:fastify:set-header:finish',
      ({ name, value, res }) => this.#handleCookies(name, value, res))
  }

  #handleCookies (name, value, res) {
    if (name.toLowerCase() === 'set-cookie') {
      let allCookies = value
      if (typeof value === 'string') {
        allCookies = [value]
      }
      const alreadyCheckedCookies = this.#getAlreadyCheckedCookiesInResponse(res)

      let location
      for (const cookieString of allCookies) {
        if (!alreadyCheckedCookies.includes(cookieString)) {
          alreadyCheckedCookies.push(cookieString)
          const parsedCookie = this.#parseCookie(cookieString, location)
          setCookieChannel.publish(parsedCookie)
          location = parsedCookie.location
        }
      }
    }
  }

  #parseCookie (cookieString, location) {
    const cookieParts = cookieString.split(';')
    const nameValueParts = cookieParts[0].split('=')
    const cookieName = nameValueParts[0]
    const cookieValue = nameValueParts.slice(1).join('=')
    const cookieProperties = cookieParts.slice(1).map(part => part.trim())

    return { cookieName, cookieValue, cookieProperties, cookieString, location }
  }

  #getAlreadyCheckedCookiesInResponse (res) {
    let alreadyCheckedCookies = this.cookiesInRequest.get(res)
    if (!alreadyCheckedCookies) {
      alreadyCheckedCookies = []
      this.cookiesInRequest.set(res, alreadyCheckedCookies)
    }
    return alreadyCheckedCookies
  }
}

module.exports = new SetCookiesHeaderInterceptor()
