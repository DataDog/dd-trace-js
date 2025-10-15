'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

describe('Appsec SDK', () => {
  let trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent
  let trackUserLoginSuccessV2, trackUserLoginFailureV2
  let checkUserAndSetUser, blockRequest, setUser, setTemplates
  let appsecSdk
  const tracer = {}
  const config = {}

  beforeEach(() => {
    trackUserLoginSuccessEvent = sinon.stub()
    trackUserLoginFailureEvent = sinon.stub()
    trackUserLoginSuccessV2 = sinon.stub()
    trackUserLoginFailureV2 = sinon.stub()
    trackCustomEvent = sinon.stub()
    checkUserAndSetUser = sinon.stub()
    blockRequest = sinon.stub()
    setTemplates = sinon.stub()
    setUser = sinon.stub()

    const AppsecSdk = proxyquire('../../../src/appsec/sdk', {
      './track_event': {
        trackUserLoginSuccessEvent,
        trackUserLoginFailureEvent,
        trackCustomEvent,
        trackUserLoginSuccessV2,
        trackUserLoginFailureV2
      },
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

    expect(trackUserLoginSuccessEvent).to.have.been.calledOnceWithExactly(tracer, user, metadata)
  })

  it('trackUserLoginFailureEvent should call internal function with proper params', () => {
    const userId = 'user_id'
    const exists = false
    const metadata = { key: 'value' }
    appsecSdk.trackUserLoginFailureEvent(userId, exists, metadata)

    expect(trackUserLoginFailureEvent).to.have.been.calledOnceWithExactly(tracer, userId, exists, metadata)
  })

  it('trackCustomEvent should call internal function with proper params', () => {
    const eventName = 'customEvent'
    const metadata = { key: 'value' }
    appsecSdk.trackCustomEvent(eventName, metadata)

    expect(trackCustomEvent).to.have.been.calledOnceWithExactly(tracer, eventName, metadata)
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

  describe('eventTrackingV2', () => {
    it('eventTrackingV2.trackUserLoginSuccess(login, user, metadata) should ' +
      'call internal function with proper params', () => {
      const login = 'login'
      const user = { id: 'user_id' }
      const metadata = { key: 'value' }

      appsecSdk.eventTrackingV2.trackUserLoginSuccess(login, user, metadata)

      expect(trackUserLoginSuccessV2).to.have.been.calledOnceWithExactly(tracer, login, user, metadata)
    })

    it('eventTrackingV2.trackUserLoginSuccess(login, user) should call internal function with proper params', () => {
      const login = 'login'
      const user = { id: 'user_id' }

      appsecSdk.eventTrackingV2.trackUserLoginSuccess(login, user)

      expect(trackUserLoginSuccessV2).to.have.been.calledOnceWithExactly(tracer, login, user, undefined)
    })

    it('eventTrackingV2.trackUserLoginSuccess(login) should call internal function with proper params', () => {
      const login = 'login'

      appsecSdk.eventTrackingV2.trackUserLoginSuccess(login)

      expect(trackUserLoginSuccessV2).to.have.been.calledOnceWithExactly(tracer, login, undefined, undefined)
    })

    it('eventTrackingV2.trackUserLoginFailure(login, exists, meta) should ' +
      'call internal function with proper params', () => {
      const login = 'login'
      const exists = false
      const metadata = { key: 'value' }

      appsecSdk.eventTrackingV2.trackUserLoginFailure(login, exists, metadata)

      expect(trackUserLoginFailureV2).to.have.been.calledOnceWithExactly(tracer, login, exists, metadata)
    })

    it('eventTrackingV2.trackUserLoginFailure(login) should call internal function with proper params', () => {
      const login = 'login'

      appsecSdk.eventTrackingV2.trackUserLoginFailure(login)

      expect(trackUserLoginFailureV2).to.have.been.calledOnceWithExactly(tracer, login, undefined, undefined)
    })

    it('eventTrackingV2.trackUserLoginFailure(login, exists) should call internal function with proper params', () => {
      const login = 'login'
      const exists = false

      appsecSdk.eventTrackingV2.trackUserLoginFailure(login, exists)

      expect(trackUserLoginFailureV2).to.have.been.calledOnceWithExactly(tracer, login, exists, undefined)
    })

    it('eventTrackingV2.trackUserLoginFailure(login, meta) should call internal function with proper params', () => {
      const login = 'login'
      const metadata = { key: 'value' }

      appsecSdk.eventTrackingV2.trackUserLoginFailure(login, metadata)

      expect(trackUserLoginFailureV2).to.have.been.calledOnceWithExactly(tracer, login, metadata, undefined)
    })
  })
})
