'use strict'

const proxyquire = require('proxyquire')

describe('track_event', () => {
  let log
  let trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent
  let getRootSpan
  let tracer

  beforeEach(() => {
    log = {
      warn: sinon.stub()
    }
    getRootSpan = sinon.stub()
    tracer = {
      setUser: sinon.stub(),
      addTags: sinon.stub()
    }
    const trackEvent = proxyquire('../../../src/appsec/sdk/track_event', {
      '../../log': log,
      './utils': {
        getRootSpan
      }
    })
    trackUserLoginSuccessEvent = trackEvent.trackUserLoginSuccessEvent
    trackUserLoginFailureEvent = trackEvent.trackUserLoginFailureEvent
    trackCustomEvent = trackEvent.trackCustomEvent
  })

  describe('trackUserLoginSuccessEvent', () => {
    it('should call to log.warn with a message when user is not send', () => {
      trackUserLoginSuccessEvent(tracer, null, { key: 'value' })
      expect(log.warn).to.be.calledOnce
      expect(log.warn).to.be.calledOnceWith('User not provided to trackUserLoginSuccessEvent')
      expect(tracer.setUser).not.to.be.called
      expect(tracer.addTags).not.to.be.called
    })

    it('should call to log.warn with a message when root span is not available', () => {
      trackUserLoginSuccessEvent(tracer, { id: 'user_id' }, { key: 'value' })
      expect(log.warn).to.be.calledOnce
      expect(log.warn).to.be.calledOnceWith('Expected root span available in trackUserLoginSuccessEvent')
      expect(tracer.setUser).not.to.be.called
      expect(tracer.addTags).not.to.be.called
    })

    it('should call to setUser', () => {
      const rootSpan = {
        addTags: sinon.stub()
      }
      getRootSpan.returns(rootSpan)
      const user = { id: 'user_id' }
      trackUserLoginSuccessEvent(tracer, user, { key: 'value' })
      expect(log.warn).not.to.be.called
      expect(tracer.setUser).to.be.calledOnceWith(user)
      expect(rootSpan.addTags).to.be.called
    })
    it('should call to addTags with metadata', () => {
      const rootSpan = {
        addTags: sinon.stub()
      }
      getRootSpan.returns(rootSpan)
      const user = { id: 'user_id' }
      trackUserLoginSuccessEvent(tracer, user, {
        metakey1: 'metaValue1', metakey2: 'metaValue2', metakey3: 'metaValue3'
      })
      expect(log.warn).not.to.be.called
      expect(tracer.setUser).to.be.calledOnceWith(user)
      expect(rootSpan.addTags).to.be.calledOnceWith({
        'appsec.events.users.login.success.track': 'true',
        'appsec.events.users.login.success.metakey1': 'metaValue1',
        'appsec.events.users.login.success.metakey2': 'metaValue2',
        'appsec.events.users.login.success.metakey3': 'metaValue3',
        'manual.keep': 'true'
      })
    })

    it('should call to addTags without metadata', () => {
      const rootSpan = {
        addTags: sinon.stub()
      }
      getRootSpan.returns(rootSpan)
      const user = { id: 'user_id' }
      trackUserLoginSuccessEvent(tracer, user)
      expect(log.warn).not.to.be.called
      expect(tracer.setUser).to.be.calledOnceWith(user)
      expect(rootSpan.addTags).to.be.calledOnceWith({
        'appsec.events.users.login.success.track': 'true',
        'manual.keep': 'true'
      })
    })
  })

  describe('trackUserLoginFailureEvent', () => {
    it('should call to log.warn if userId is not defined', () => {
      trackUserLoginFailureEvent(tracer, null, false)
      expect(log.warn).to.be.calledOnce
      expect(log.warn).to.be.calledOnceWith('Invalid userId provided to trackUserLoginFailureEvent')
      expect(tracer.setUser).not.to.be.called
      expect(tracer.addTags).not.to.be.called
    })

    it('should call to log.warn if rootSpan is not available', () => {
      getRootSpan.returns(null)
      trackUserLoginFailureEvent(tracer, 'user_id', false)
      expect(log.warn).to.be.calledOnce
      expect(log.warn).to.be.calledOnceWith('Expected root span available in trackUserLoginFailureEvent')
      expect(tracer.setUser).not.to.be.called
      expect(tracer.addTags).not.to.be.called
    })

    it('should call to addTags with metadata', () => {
      const rootSpan = {
        addTags: sinon.stub()
      }
      getRootSpan.returns(rootSpan)
      trackUserLoginFailureEvent(tracer, 'user_id', true, {
        metakey1: 'metaValue1', metakey2: 'metaValue2', metakey3: 'metaValue3'
      })
      expect(log.warn).not.to.be.called
      expect(tracer.setUser).not.to.be.called
      expect(rootSpan.addTags).to.be.calledOnceWith({
        'appsec.events.users.login.failure.track': 'true',
        'appsec.events.users.login.failure.usr.id': 'user_id',
        'appsec.events.users.login.failure.usr.exists': 'true',
        'appsec.events.users.login.failure.metakey1': 'metaValue1',
        'appsec.events.users.login.failure.metakey2': 'metaValue2',
        'appsec.events.users.login.failure.metakey3': 'metaValue3',
        'manual.keep': 'true'
      })
    })

    it('should send false `usr.exists` property when the user does not exist', () => {
      const rootSpan = {
        addTags: sinon.stub()
      }
      getRootSpan.returns(rootSpan)
      trackUserLoginFailureEvent(tracer, 'user_id', false, {
        metakey1: 'metaValue1', metakey2: 'metaValue2', metakey3: 'metaValue3'
      })
      expect(log.warn).not.to.be.called
      expect(tracer.setUser).not.to.be.called
      expect(rootSpan.addTags).to.be.calledOnceWith({
        'appsec.events.users.login.failure.track': 'true',
        'appsec.events.users.login.failure.usr.id': 'user_id',
        'appsec.events.users.login.failure.usr.exists': 'false',
        'appsec.events.users.login.failure.metakey1': 'metaValue1',
        'appsec.events.users.login.failure.metakey2': 'metaValue2',
        'appsec.events.users.login.failure.metakey3': 'metaValue3',
        'manual.keep': 'true'
      })
    })

    it('should call to addTags without metadata', () => {
      const rootSpan = {
        addTags: sinon.stub()
      }
      getRootSpan.returns(rootSpan)
      trackUserLoginFailureEvent(tracer, 'user_id', false)
      expect(log.warn).not.to.be.called
      expect(tracer.setUser).not.to.be.called
      expect(rootSpan.addTags).to.be.calledOnceWith({
        'appsec.events.users.login.failure.track': 'true',
        'appsec.events.users.login.failure.usr.id': 'user_id',
        'appsec.events.users.login.failure.usr.exists': 'false',
        'manual.keep': 'true'
      })
    })
  })

  describe('trackCustomEvent', () => {
    it('should log.warm with null eventName', () => {
      trackCustomEvent(tracer, null)
      expect(log.warn).to.be.calledOnce
      expect(log.warn).to.be.calledOnceWith('Invalid eventName received in trackCustomEvent')
      expect(tracer.setUser).not.to.be.called
      expect(tracer.addTags).not.to.be.called
    })

    it('should log.warm with invalid eventName', () => {
      trackCustomEvent(tracer, { name: 'name' })
      expect(log.warn).to.be.calledOnce
      expect(log.warn).to.be.calledOnceWith('Invalid eventName received in trackCustomEvent')
      expect(tracer.addTags).not.to.be.called
    })

    it('should log.warm without root span', () => {
      trackCustomEvent(tracer, 'custom_event')
      expect(log.warn).to.be.calledOnce
      expect(log.warn).to.be.calledOnceWith('Expected root span available in trackCustomEvent')
      expect(tracer.addTags).not.to.be.called
    })

    it('should call addTags with metadata', () => {
      const rootSpan = {
        addTags: sinon.stub()
      }
      getRootSpan.returns(rootSpan)
      trackCustomEvent(tracer, 'custom_event', { metaKey1: 'metaValue1', metakey2: 'metaValue2' })
      expect(log.warn).not.to.be.called
      expect(rootSpan.addTags).to.be.calledOnce
      expect(rootSpan.addTags).to.be.calledOnceWith({
        'appsec.events.custom_event.track': 'true',
        'appsec.events.custom_event.metaKey1': 'metaValue1',
        'appsec.events.custom_event.metakey2': 'metaValue2',
        'manual.keep': 'true'
      })
    })
  })
})
