'use strict'

const proxyquire = require('proxyquire')

describe('track_event', () => {
  const tracer = {}
  let log
  let rootSpan
  let getRootSpan
  let setUserTags
  let trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent

  beforeEach(() => {
    log = {
      warn: sinon.stub()
    }

    rootSpan = {
      addTags: sinon.stub()
    }

    getRootSpan = sinon.stub().callsFake(() => rootSpan)

    setUserTags = sinon.stub()

    const trackEvent = proxyquire('../../../src/appsec/sdk/track_event', {
      '../../log': log,
      './utils': {
        getRootSpan
      },
      './set_user': {
        setUserTags
      }
    })

    trackUserLoginSuccessEvent = trackEvent.trackUserLoginSuccessEvent
    trackUserLoginFailureEvent = trackEvent.trackUserLoginFailureEvent
    trackCustomEvent = trackEvent.trackCustomEvent
  })

  describe('trackUserLoginSuccessEvent', () => {
    it('should log warning when passed invalid user', () => {
      trackUserLoginSuccessEvent(tracer, null, { key: 'value' })
      trackUserLoginSuccessEvent(tracer, {}, { key: 'value' })

      expect(log.warn).to.have.been.calledTwice
      expect(log.warn.firstCall).to.have.been.calledWithExactly('Invalid user provided to trackUserLoginSuccessEvent')
      expect(log.warn.secondCall).to.have.been.calledWithExactly('Invalid user provided to trackUserLoginSuccessEvent')
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.not.have.been.called
    })

    it('should log warning when root span is not available', () => {
      rootSpan = undefined

      trackUserLoginSuccessEvent(tracer, { id: 'user_id' }, { key: 'value' })

      expect(log.warn).to.have.been.calledOnceWithExactly('Root span not available in trackUserLoginSuccessEvent')
      expect(setUserTags).to.not.have.been.called
    })

    it('should call setUser and addTags with metadata', () => {
      const user = { id: 'user_id' }

      trackUserLoginSuccessEvent(tracer, user, {
        metakey1: 'metaValue1',
        metakey2: 'metaValue2',
        metakey3: 'metaValue3'
      })

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.have.been.calledOnceWithExactly(user, rootSpan)
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.users.login.success.track': 'true',
        'appsec.events.users.login.success.metakey1': 'metaValue1',
        'appsec.events.users.login.success.metakey2': 'metaValue2',
        'appsec.events.users.login.success.metakey3': 'metaValue3',
        'manual.keep': 'true'
      })
    })

    it('should call setUser and addTags without metadata', () => {
      const user = { id: 'user_id' }

      trackUserLoginSuccessEvent(tracer, user)

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.have.been.calledOnceWithExactly(user, rootSpan)
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.users.login.success.track': 'true',
        'manual.keep': 'true'
      })
    })
  })

  describe('trackUserLoginFailureEvent', () => {
    it('should log warning when passed invalid userId', () => {
      trackUserLoginFailureEvent(tracer, null, false)
      trackUserLoginFailureEvent(tracer, [], false)

      expect(log.warn).to.have.been.calledTwice
      expect(log.warn.firstCall).to.have.been.calledWithExactly('Invalid userId provided to trackUserLoginFailureEvent')
      expect(log.warn.secondCall)
        .to.have.been.calledWithExactly('Invalid userId provided to trackUserLoginFailureEvent')
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.not.have.been.called
    })

    it('should log warning when root span is not available', () => {
      rootSpan = undefined

      trackUserLoginFailureEvent(tracer, 'user_id', false)

      expect(log.warn).to.have.been.calledOnceWithExactly('Root span not available in trackUserLoginFailureEvent')
      expect(setUserTags).to.not.have.been.called
    })

    it('should call addTags with metadata', () => {
      trackUserLoginFailureEvent(tracer, 'user_id', true, {
        metakey1: 'metaValue1', metakey2: 'metaValue2', metakey3: 'metaValue3'
      })

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
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
      trackUserLoginFailureEvent(tracer, 'user_id', false, {
        metakey1: 'metaValue1', metakey2: 'metaValue2', metakey3: 'metaValue3'
      })

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.users.login.failure.track': 'true',
        'appsec.events.users.login.failure.usr.id': 'user_id',
        'appsec.events.users.login.failure.usr.exists': 'false',
        'appsec.events.users.login.failure.metakey1': 'metaValue1',
        'appsec.events.users.login.failure.metakey2': 'metaValue2',
        'appsec.events.users.login.failure.metakey3': 'metaValue3',
        'manual.keep': 'true'
      })
    })

    it('should call addTags without metadata', () => {
      trackUserLoginFailureEvent(tracer, 'user_id', true)

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.users.login.failure.track': 'true',
        'appsec.events.users.login.failure.usr.id': 'user_id',
        'appsec.events.users.login.failure.usr.exists': 'true',
        'manual.keep': 'true'
      })
    })
  })

  describe('trackCustomEvent', () => {
    it('should log warning when passed invalid eventName', () => {
      trackCustomEvent(tracer, null)
      trackCustomEvent(tracer, { name: 'name' })

      expect(log.warn).to.have.been.calledTwice
      expect(log.warn.firstCall).to.have.been.calledWithExactly('Invalid eventName provided to trackCustomEvent')
      expect(log.warn.secondCall).to.have.been.calledWithExactly('Invalid eventName provided to trackCustomEvent')
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.not.have.been.called
    })

    it('should log warning when root span is not available', () => {
      rootSpan = undefined

      trackCustomEvent(tracer, 'custom_event')

      expect(log.warn).to.have.been.calledOnceWithExactly('Root span not available in trackCustomEvent')
      expect(setUserTags).to.not.have.been.called
    })

    it('should call addTags with metadata', () => {
      trackCustomEvent(tracer, 'custom_event', { metaKey1: 'metaValue1', metakey2: 'metaValue2' })

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.custom_event.track': 'true',
        'appsec.events.custom_event.metaKey1': 'metaValue1',
        'appsec.events.custom_event.metakey2': 'metaValue2',
        'manual.keep': 'true'
      })
    })

    it('should call addTags without metadata', () => {
      trackCustomEvent(tracer, 'custom_event')

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.custom_event.track': 'true',
        'manual.keep': 'true'
      })
    })
  })
})
