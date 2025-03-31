'use strict'

const proxyquire = require('proxyquire')
const { LOGIN_SUCCESS, LOGIN_FAILURE, USER_ID, USER_LOGIN } = require('../../../src/appsec/addresses')
const { USER_KEEP } = require('../../../../../ext/priority')
const { ASM } = require('../../../src/standalone/product')

describe('track_event - Internal API', () => {
  const tracer = {}
  let log
  let prioritySampler
  let rootSpan
  let getRootSpan
  let setUserTags
  let waf
  let telemetry
  let trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent

  beforeEach(() => {
    log = {
      warn: sinon.stub()
    }

    prioritySampler = {
      setPriority: sinon.stub()
    }

    rootSpan = {
      _prioritySampler: prioritySampler,
      addTags: sinon.stub(),
      keep: sinon.stub()
    }

    getRootSpan = sinon.stub().callsFake(() => rootSpan)

    setUserTags = sinon.stub()

    waf = {
      run: sinon.spy()
    }

    telemetry = {
      incrementSdkEventMetric: sinon.stub()
    }

    const trackEvents = proxyquire('../../../src/appsec/sdk/track_event', {
      '../../log': log,
      './utils': {
        getRootSpan
      },
      './set_user': {
        setUserTags
      },
      '../waf': waf,
      '../telemetry': telemetry
    })

    trackUserLoginSuccessEvent = trackEvents.trackUserLoginSuccessEvent
    trackUserLoginFailureEvent = trackEvents.trackUserLoginFailureEvent
    trackCustomEvent = trackEvents.trackCustomEvent
  })

  describe('trackUserLoginSuccessEvent', () => {
    it('should log warning when passed invalid user', () => {
      trackUserLoginSuccessEvent(tracer, null, { key: 'value' })
      trackUserLoginSuccessEvent(tracer, {}, { key: 'value' })

      expect(log.warn).to.have.been.calledTwice
      expect(log.warn.firstCall)
        .to.have.been.calledWithExactly('[ASM] Invalid user provided to trackUserLoginSuccessEvent')
      expect(log.warn.secondCall)
        .to.have.been.calledWithExactly('[ASM] Invalid user provided to trackUserLoginSuccessEvent')
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.not.have.been.called
      expect(telemetry.incrementSdkEventMetric).to.not.have.been.called
    })

    it('should log warning when root span is not available', () => {
      rootSpan = undefined

      trackUserLoginSuccessEvent(tracer, { id: 'user_id' }, { key: 'value' })

      expect(log.warn)
        .to.have.been.calledOnceWithExactly('[ASM] Root span not available in trackUserLoginSuccessEvent')
      expect(setUserTags).to.not.have.been.called
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWith('login_success')
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
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
        {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.login': 'user_id',
          'appsec.events.users.login.success.metakey1': 'metaValue1',
          'appsec.events.users.login.success.metakey2': 'metaValue2',
          'appsec.events.users.login.success.metakey3': 'metaValue3'
        })
      expect(prioritySampler.setPriority)
        .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, ASM)
      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          [LOGIN_SUCCESS]: null,
          [USER_ID]: 'user_id',
          [USER_LOGIN]: 'user_id'
        }
      })
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWith('login_success')
    })

    it('should call setUser and addTags without metadata', () => {
      const user = { id: 'user_id' }

      trackUserLoginSuccessEvent(tracer, user)

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.have.been.calledOnceWithExactly(user, rootSpan)
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.users.login.success.track': 'true',
        '_dd.appsec.events.users.login.success.sdk': 'true',
        'appsec.events.users.login.success.usr.login': 'user_id'
      })
      expect(prioritySampler.setPriority)
        .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, ASM)
      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          [LOGIN_SUCCESS]: null,
          [USER_ID]: 'user_id',
          [USER_LOGIN]: 'user_id'
        }
      })
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWith('login_success')
    })

    it('should call waf with user login', () => {
      const user = { id: 'user_id', login: 'user_login' }

      trackUserLoginSuccessEvent(tracer, user)

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.have.been.calledOnceWithExactly(user, rootSpan)
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.users.login.success.track': 'true',
        '_dd.appsec.events.users.login.success.sdk': 'true',
        'appsec.events.users.login.success.usr.login': 'user_login'
      })
      expect(prioritySampler.setPriority)
        .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, ASM)
      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          [LOGIN_SUCCESS]: null,
          [USER_ID]: 'user_id',
          [USER_LOGIN]: 'user_login'
        }
      })
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWith('login_success')
    })
  })

  describe('trackUserLoginFailureEvent', () => {
    it('should log warning when passed invalid userId', () => {
      trackUserLoginFailureEvent(tracer, null, false, { key: 'value' })
      trackUserLoginFailureEvent(tracer, [], false, { key: 'value' })

      expect(log.warn).to.have.been.calledTwice
      expect(log.warn.firstCall)
        .to.have.been.calledWithExactly('[ASM] Invalid userId provided to trackUserLoginFailureEvent')
      expect(log.warn.secondCall)
        .to.have.been.calledWithExactly('[ASM] Invalid userId provided to trackUserLoginFailureEvent')
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.not.have.been.called
      expect(telemetry.incrementSdkEventMetric).to.not.have.been.called
    })

    it('should log warning when root span is not available', () => {
      rootSpan = undefined

      trackUserLoginFailureEvent(tracer, 'user_id', false, { key: 'value' })

      expect(log.warn)
        .to.have.been.calledOnceWithExactly('[ASM] Root span not available in %s', 'trackUserLoginFailureEvent')
      expect(setUserTags).to.not.have.been.called
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWith('login_failure')
    })

    it('should call addTags with metadata', () => {
      trackUserLoginFailureEvent(tracer, 'user_id', true, {
        metakey1: 'metaValue1',
        metakey2: 'metaValue2',
        metakey3: 'metaValue3'
      })

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.users.login.failure.track': 'true',
        '_dd.appsec.events.users.login.failure.sdk': 'true',
        'appsec.events.users.login.failure.usr.id': 'user_id',
        'appsec.events.users.login.failure.usr.login': 'user_id',
        'appsec.events.users.login.failure.usr.exists': 'true',
        'appsec.events.users.login.failure.metakey1': 'metaValue1',
        'appsec.events.users.login.failure.metakey2': 'metaValue2',
        'appsec.events.users.login.failure.metakey3': 'metaValue3'
      })
      expect(prioritySampler.setPriority)
        .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, ASM)
      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          [LOGIN_FAILURE]: null,
          [USER_LOGIN]: 'user_id'
        }
      })
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWith('login_failure')
    })

    it('should send false `usr.exists` property when the user does not exist', () => {
      trackUserLoginFailureEvent(tracer, 'user_id', false, {
        metakey1: 'metaValue1',
        metakey2: 'metaValue2',
        metakey3: 'metaValue3'
      })

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.users.login.failure.track': 'true',
        '_dd.appsec.events.users.login.failure.sdk': 'true',
        'appsec.events.users.login.failure.usr.id': 'user_id',
        'appsec.events.users.login.failure.usr.login': 'user_id',
        'appsec.events.users.login.failure.usr.exists': 'false',
        'appsec.events.users.login.failure.metakey1': 'metaValue1',
        'appsec.events.users.login.failure.metakey2': 'metaValue2',
        'appsec.events.users.login.failure.metakey3': 'metaValue3'
      })
      expect(prioritySampler.setPriority)
        .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, ASM)
      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          [LOGIN_FAILURE]: null,
          [USER_LOGIN]: 'user_id'
        }
      })
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWith('login_failure')
    })

    it('should call addTags without metadata', () => {
      trackUserLoginFailureEvent(tracer, 'user_id', true)

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.users.login.failure.track': 'true',
        '_dd.appsec.events.users.login.failure.sdk': 'true',
        'appsec.events.users.login.failure.usr.id': 'user_id',
        'appsec.events.users.login.failure.usr.login': 'user_id',
        'appsec.events.users.login.failure.usr.exists': 'true'
      })
      expect(prioritySampler.setPriority)
        .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, ASM)
      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          [LOGIN_FAILURE]: null,
          [USER_LOGIN]: 'user_id'
        }
      })
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWith('login_failure')
    })
  })

  describe('trackCustomEvent', () => {
    it('should log warning when passed invalid eventName', () => {
      trackCustomEvent(tracer, null)
      trackCustomEvent(tracer, { name: 'name' })

      expect(log.warn).to.have.been.calledTwice
      expect(log.warn.firstCall)
        .to.have.been.calledWithExactly('[ASM] Invalid eventName provided to trackCustomEvent')
      expect(log.warn.secondCall)
        .to.have.been.calledWithExactly('[ASM] Invalid eventName provided to trackCustomEvent')
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.not.have.been.called
      expect(telemetry.incrementSdkEventMetric).to.not.have.been.called
    })

    it('should log warning when root span is not available', () => {
      rootSpan = undefined

      trackCustomEvent(tracer, 'custom_event')

      expect(log.warn)
        .to.have.been.calledOnceWithExactly('[ASM] Root span not available in %s', 'trackCustomEvent')
      expect(setUserTags).to.not.have.been.called
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWith('custom')
    })

    it('should call addTags with metadata', () => {
      trackCustomEvent(tracer, 'custom_event', {
        metaKey1: 'metaValue1',
        metakey2: 'metaValue2'
      })

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.custom_event.track': 'true',
        '_dd.appsec.events.custom_event.sdk': 'true',
        'appsec.events.custom_event.metaKey1': 'metaValue1',
        'appsec.events.custom_event.metakey2': 'metaValue2'
      })
      expect(prioritySampler.setPriority)
        .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, ASM)
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWith('custom')
    })

    it('should call addTags without metadata', () => {
      trackCustomEvent(tracer, 'custom_event')

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.custom_event.track': 'true',
        '_dd.appsec.events.custom_event.sdk': 'true'
      })
      expect(prioritySampler.setPriority)
        .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, ASM)
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWith('custom')
    })
  })
})
