'use strict'

const setCookiesHeaderInterceptor = require('../../../../src/appsec/iast/analyzers/set-cookies-header-interceptor')
const dc = require('../../../../../diagnostics_channel')

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

    expect(setCookieCallback).to.have.been.calledOnceWithExactly({
      cookieName: 'key',
      cookieValue: 'value',
      cookieProperties: ['Secure', 'HttpOnly'],
      cookieString: 'key=value; Secure; HttpOnly'
    }, 'datadog:iast:set-cookie')
  })

  it('Should not send set-cookie-event if the header is not "set-cookie"', () => {
    setHeaderChannel.publish({
      name: 'location',
      value: 'https://www.datadoghq.com',
      res: {}
    })

    expect(setCookieCallback).to.not.have.been.called
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

    expect(setCookieCallback).to.have.been.calledTwice

    expect(setCookieCallback.firstCall).to.have.been.calledWithExactly({
      cookieName: 'key1',
      cookieValue: 'value1',
      cookieProperties: [],
      cookieString: 'key1=value1'
    }, 'datadog:iast:set-cookie')

    expect(setCookieCallback.secondCall).to.have.been.calledWithExactly({
      cookieName: 'key2',
      cookieValue: 'value2',
      cookieProperties: ['Secure'],
      cookieString: 'key2=value2; Secure'
    }, 'datadog:iast:set-cookie')
  })
})
