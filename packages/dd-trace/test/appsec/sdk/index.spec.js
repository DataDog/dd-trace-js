'use strict'

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
    sinon.assert.calledOnceWithExactly(setTemplates, config)
  })

  it('trackUserLoginSuccessEvent should call internal function with proper params', () => {
    const user = { id: 'user_id' }
    const metadata = { key: 'value' }
    appsecSdk.trackUserLoginSuccessEvent(user, metadata)

    sinon.assert.calledOnceWithExactly(trackUserLoginSuccessEvent, tracer, user, metadata)
  })

  it('trackUserLoginFailureEvent should call internal function with proper params', () => {
    const userId = 'user_id'
    const exists = false
    const metadata = { key: 'value' }
    appsecSdk.trackUserLoginFailureEvent(userId, exists, metadata)

    sinon.assert.calledOnceWithExactly(trackUserLoginFailureEvent, tracer, userId, exists, metadata)
  })

  it('trackCustomEvent should call internal function with proper params', () => {
    const eventName = 'customEvent'
    const metadata = { key: 'value' }
    appsecSdk.trackCustomEvent(eventName, metadata)

    sinon.assert.calledOnceWithExactly(trackCustomEvent, tracer, eventName, metadata)
  })

  it('isUserBlocked should call internal function with proper params', () => {
    const user = { id: 'user_id' }
    appsecSdk.isUserBlocked(user)

    sinon.assert.calledOnceWithExactly(checkUserAndSetUser, tracer, user)
  })

  it('blockRequest should call internal function with proper params', () => {
    const req = { protocol: 'https' }
    const res = { headersSent: false }
    appsecSdk.blockRequest(req, res)

    sinon.assert.calledOnceWithExactly(blockRequest, tracer, req, res)
  })

  it('setUser should call internal function with proper params', () => {
    const user = { id: 'user_id' }
    appsecSdk.setUser(user)

    sinon.assert.calledOnceWithExactly(setUser, tracer, user)
  })

  describe('eventTrackingV2', () => {
    it('eventTrackingV2.trackUserLoginSuccess(login, user, metadata) should ' +
      'call internal function with proper params', () => {
      const login = 'login'
      const user = { id: 'user_id' }
      const metadata = { key: 'value' }

      appsecSdk.eventTrackingV2.trackUserLoginSuccess(login, user, metadata)

      sinon.assert.calledOnceWithExactly(trackUserLoginSuccessV2, tracer, login, user, metadata)
    })

    it('eventTrackingV2.trackUserLoginSuccess(login, user) should call internal function with proper params', () => {
      const login = 'login'
      const user = { id: 'user_id' }

      appsecSdk.eventTrackingV2.trackUserLoginSuccess(login, user)

      sinon.assert.calledOnceWithExactly(trackUserLoginSuccessV2, tracer, login, user, undefined)
    })

    it('eventTrackingV2.trackUserLoginSuccess(login) should call internal function with proper params', () => {
      const login = 'login'

      appsecSdk.eventTrackingV2.trackUserLoginSuccess(login)

      sinon.assert.calledOnceWithExactly(trackUserLoginSuccessV2, tracer, login, undefined, undefined)
    })

    it('eventTrackingV2.trackUserLoginFailure(login, exists, meta) should ' +
      'call internal function with proper params', () => {
      const login = 'login'
      const exists = false
      const metadata = { key: 'value' }

      appsecSdk.eventTrackingV2.trackUserLoginFailure(login, exists, metadata)

      sinon.assert.calledOnceWithExactly(trackUserLoginFailureV2, tracer, login, exists, metadata)
    })

    it('eventTrackingV2.trackUserLoginFailure(login) should call internal function with proper params', () => {
      const login = 'login'

      appsecSdk.eventTrackingV2.trackUserLoginFailure(login)

      sinon.assert.calledOnceWithExactly(trackUserLoginFailureV2, tracer, login, undefined, undefined)
    })

    it('eventTrackingV2.trackUserLoginFailure(login, exists) should call internal function with proper params', () => {
      const login = 'login'
      const exists = false

      appsecSdk.eventTrackingV2.trackUserLoginFailure(login, exists)

      sinon.assert.calledOnceWithExactly(trackUserLoginFailureV2, tracer, login, exists, undefined)
    })

    it('eventTrackingV2.trackUserLoginFailure(login, meta) should call internal function with proper params', () => {
      const login = 'login'
      const metadata = { key: 'value' }

      appsecSdk.eventTrackingV2.trackUserLoginFailure(login, metadata)

      sinon.assert.calledOnceWithExactly(trackUserLoginFailureV2, tracer, login, metadata, undefined)
    })
  })
})
