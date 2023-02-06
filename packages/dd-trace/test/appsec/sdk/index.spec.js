'use strict'
const proxyquire = require('proxyquire')

describe('Test public API', () => {
  const tracer = {}
  const mockReq = { protocol: 'https' }
  const mockRes = { headersSent: false }
  const loadTemplates = sinon.stub()
  let sdk, checkUserAndSetUser, blockRequest, setUser, trackUserLoginSuccessEvent, trackUserLoginFailureEvent,
    trackCustomEvent

  beforeEach(() => {
    trackUserLoginSuccessEvent = sinon.stub()
    trackUserLoginFailureEvent = sinon.stub()
    trackCustomEvent = sinon.stub()
    checkUserAndSetUser = sinon.stub()
    blockRequest = sinon.stub()
    setUser = sinon.stub()

    const AppsecSdk = proxyquire('../../../src/appsec/sdk', {
      './track_event': { trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent },
      './user_blocking': { checkUserAndSetUser, blockRequest },
      './set_user': { setUser },
      '../blocking': { loadTemplates }
    })

    sdk = new AppsecSdk(tracer)
  })

  it('Test isUserBlocked', () => {
    const user = { id: 'user' }
    sdk.isUserBlocked(user)
    expect(checkUserAndSetUser).to.be.calledWith(tracer, user)
  })

  it('Test blockRequest', () => {
    sdk.blockRequest(mockReq, mockRes)
    expect(blockRequest).to.be.calledWith(tracer, mockReq, mockRes)
  })

  it('Test setUser', () => {
    const user = { id: 'user' }
    sdk.setUser(user)
    expect(setUser).to.be.calledWith(tracer, user)
  })

  it('Test trackUserLoginSuccessEvent', () => {
    const user = { id: 'user' }
    const metadata = {}
    sdk.trackUserLoginSuccessEvent(user, metadata)
    expect(trackUserLoginSuccessEvent).to.be.calledWith(tracer, user, metadata)
  })

  it('Test trackUserLoginFailureEvent', () => {
    const user = { id: 'user' }
    const metadata = {}
    sdk.trackUserLoginFailureEvent(user, metadata)
    expect(trackUserLoginFailureEvent).to.be.calledWith(tracer, user, metadata)
  })

  it('Test trackCustomEvent', () => {
    const eventName = 'customEvent'
    const metadata = {}
    sdk.trackUserLoginFailureEvent(eventName, metadata)
    expect(trackUserLoginFailureEvent).to.be.calledWith(tracer, eventName, metadata)
  })
})
