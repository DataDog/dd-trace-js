'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const setCookiesHeaderInterceptor = require('../../../../src/appsec/iast/analyzers/set-cookies-header-interceptor')
const iastSetCookieChannel = dc.channel('datadog:iast:set-cookie')
const setHeaderChannel = dc.channel('datadog:http:server:response:set-header:finish')

describe('Test IntermediateCookiesAnalyzer', () => {
  let setCookieCallback

  beforeEach(() => {
    setCookieCallback = sinon.stub()
    setCookiesHeaderInterceptor.configure(true)
    iastSetCookieChannel.subscribe(setCookieCallback)
  })

  afterEach(() => {
    setCookiesHeaderInterceptor.configure(false)
    iastSetCookieChannel.unsubscribe(setCookieCallback)
  })

  it('Should send set-cookie-event if the header is "set-cookie"', () => {
    setHeaderChannel.publish({
      name: 'set-cookie',
      value: 'key=value; Secure; HttpOnly',
      res: {}
    })

    sinon.assert.calledOnceWithExactly(setCookieCallback, {
      cookieName: 'key',
      cookieValue: 'value',
      cookieProperties: ['Secure', 'HttpOnly'],
      cookieString: 'key=value; Secure; HttpOnly',
      location: undefined
    }, 'datadog:iast:set-cookie')
  })

  it('Should not send set-cookie-event if the header is not "set-cookie"', () => {
    setHeaderChannel.publish({
      name: 'location',
      value: 'https://www.datadoghq.com',
      res: {}
    })

    sinon.assert.notCalled(setCookieCallback)
  })

  it('Should not send same cookie twice in the same response', () => {
    const res = {}
    setHeaderChannel.publish({
      name: 'set-cookie',
      value: 'key1=value1',
      res
    })
    setHeaderChannel.publish({
      name: 'set-cookie',
      value: ['key1=value1', 'key2=value2; Secure'],
      res
    })

    sinon.assert.calledTwice(setCookieCallback)

    sinon.assert.calledWithExactly(setCookieCallback.firstCall, {
      cookieName: 'key1',
      cookieValue: 'value1',
      cookieProperties: [],
      cookieString: 'key1=value1',
      location: undefined
    }, 'datadog:iast:set-cookie')

    sinon.assert.calledWithExactly(setCookieCallback.secondCall, {
      cookieName: 'key2',
      cookieValue: 'value2',
      cookieProperties: ['Secure'],
      cookieString: 'key2=value2; Secure',
      location: undefined
    }, 'datadog:iast:set-cookie')
  })

  it('should reuse the location filled in setCookie callback', () => {
    let i = 0
    const location = { path: 'test.js', line: 12 }
    setCookieCallback.callsFake(function (event) {
      if (i === 0) {
        assert.strictEqual(event.location, undefined)
        event.location = location
        i++
      } else {
        assert.strictEqual(event.location, location)
      }
    })

    const res = {}
    setHeaderChannel.publish({
      name: 'set-cookie',
      value: ['key1=value1', 'key2=value2'],
      res
    })

    sinon.assert.calledTwice(setCookieCallback)
  })
})
