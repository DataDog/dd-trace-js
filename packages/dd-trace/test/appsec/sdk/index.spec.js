'use strict'

const proxyquire = require('proxyquire')

describe('Appsec SDK', () => {
  let trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent
  let checkUserAndSetUser, blockRequest, setUser, setTemplates
  let appsecSdk
  const tracer = {}
  const config = {
    appsec: {
      standalone: {
        enabled: null
      }
    }
  }

  beforeEach(() => {
    trackUserLoginSuccessEvent = sinon.stub()
    trackUserLoginFailureEvent = sinon.stub()
    trackCustomEvent = sinon.stub()
    checkUserAndSetUser = sinon.stub()
    blockRequest = sinon.stub()
    setTemplates = sinon.stub()
    setUser = sinon.stub()

    const AppsecSdk = proxyquire('../../../src/appsec/sdk', {
      './track_event': { trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent },
      './user_blocking': { checkUserAndSetUser, blockRequest },
      '../blocking': { setTemplates },
      './set_user': { setUser }
    })

    appsecSdk = new AppsecSdk(tracer, config)
  })

  it('should call setTemplates when instanciated', () => {
    expect(setTemplates).to.have.been.calledOnceWithExactly(config)
  })

  it('trackUserLoginSuccessEvent should call internal function with proper params', () => {
    const user = { id: 'user_id' }
    const metadata = { key: 'value' }
    appsecSdk.trackUserLoginSuccessEvent(user, metadata)

    expect(trackUserLoginSuccessEvent).to.have.been.calledOnceWithExactly(tracer, user, metadata, false)
  })

  it('trackUserLoginFailureEvent should call internal function with proper params', () => {
    const userId = 'user_id'
    const exists = false
    const metadata = { key: 'value' }
    appsecSdk.trackUserLoginFailureEvent(userId, exists, metadata)

    expect(trackUserLoginFailureEvent).to.have.been.calledOnceWithExactly(tracer, userId, exists, metadata, false)
  })

  it('trackCustomEvent should call internal function with proper params', () => {
    const eventName = 'customEvent'
    const metadata = { key: 'value' }
    appsecSdk.trackCustomEvent(eventName, metadata)

    expect(trackCustomEvent).to.have.been.calledOnceWithExactly(tracer, eventName, metadata, false)
  })

  it('isUserBlocked should call internal function with proper params', () => {
    const user = { id: 'user_id' }
    appsecSdk.isUserBlocked(user)

    expect(checkUserAndSetUser).to.have.been.calledOnceWithExactly(tracer, user)
  })

  it('blockRequest should call internal function with proper params', () => {
    const req = { protocol: 'https' }
    const res = { headersSent: false }
    appsecSdk.blockRequest(req, res)

    expect(blockRequest).to.have.been.calledOnceWithExactly(tracer, req, res)
  })

  it('setUser should call internal function with proper params', () => {
    const user = { id: 'user_id' }
    appsecSdk.setUser(user)

    expect(setUser).to.have.been.calledOnceWithExactly(tracer, user)
  })

  describe('standalone appsec enabled', () => {
    beforeEach(() => {
      config.appsec.standalone.enabled = true

      const AppsecSdk = proxyquire('../../../src/appsec/sdk', {
        './track_event': { trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent },
        './user_blocking': { checkUserAndSetUser, blockRequest },
        '../blocking': { setTemplates },
        './set_user': { setUser }
      })

      appsecSdk = new AppsecSdk(tracer, config)
    })

    it('trackUserLoginSuccessEvent should call internal function with proper params', () => {
      const user = { id: 'user_id' }
      const metadata = { key: 'value' }
      appsecSdk.trackUserLoginSuccessEvent(user, metadata)

      expect(trackUserLoginSuccessEvent).to.have.been.calledOnceWithExactly(tracer, user, metadata, true)
    })

    it('trackUserLoginFailureEvent should call internal function with proper params', () => {
      const userId = 'user_id'
      const exists = false
      const metadata = { key: 'value' }
      appsecSdk.trackUserLoginFailureEvent(userId, exists, metadata)

      expect(trackUserLoginFailureEvent).to.have.been.calledOnceWithExactly(tracer, userId, exists, metadata, true)
    })

    it('trackCustomEvent should call internal function with proper params', () => {
      const eventName = 'customEvent'
      const metadata = { key: 'value' }
      appsecSdk.trackCustomEvent(eventName, metadata)

      expect(trackCustomEvent).to.have.been.calledOnceWithExactly(tracer, eventName, metadata, true)
    })
  })
})
