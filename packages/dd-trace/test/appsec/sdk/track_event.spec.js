'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
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
  let trackUserLoginSuccessV2, trackUserLoginFailureV2

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
    trackUserLoginSuccessV2 = trackEvents.trackUserLoginSuccessV2
    trackUserLoginFailureV2 = trackEvents.trackUserLoginFailureV2
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
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('login_success', 'v1')
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
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('login_success', 'v1')
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
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('login_success', 'v1')
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
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('login_success', 'v1')
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
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('login_failure', 'v1')
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
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('login_failure', 'v1')
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
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('login_failure', 'v1')
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
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('login_failure', 'v1')
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
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('custom', 'v1')
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
      expect(waf.run).to.not.have.been.called
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('custom', 'v1')
    })

    it('should call addTags without metadata', () => {
      trackCustomEvent(tracer, 'custom_event')

      expect(log.warn).to.not.have.been.called
      expect(setUserTags).to.not.have.been.called
      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        'appsec.events.custom_event.track': 'true',
        '_dd.appsec.events.custom_event.sdk': 'true'
      })
      expect(waf.run).to.not.have.been.called
      expect(prioritySampler.setPriority)
        .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, ASM)
      expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('custom', 'v1')
    })

    it('should call to the waf when event name is "users.login.success"', () => {
      trackCustomEvent(tracer, 'users.login.success')

      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          [LOGIN_SUCCESS]: null
        }
      })
    })

    it('should call to the waf when event name is "users.login.failure"', () => {
      trackCustomEvent(tracer, 'users.login.failure')

      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          [LOGIN_FAILURE]: null
        }
      })
    })
  })

  describe('eventTrackingV2', () => {
    describe('trackUserLoginSuccessV2', () => {
      it('should log warning when root span is not available', () => {
        rootSpan = undefined

        trackUserLoginSuccessV2(tracer, 'login')

        expect(log.warn)
          .to.have.been.calledOnceWithExactly('[ASM] Root span not available in eventTrackingV2.trackUserLoginSuccess')
        expect(setUserTags).to.not.have.been.called
      })

      it('should log warning when passed invalid login', () => {
        trackUserLoginSuccessV2(tracer, null)
        trackUserLoginSuccessV2(tracer, {})

        expect(log.warn).to.have.been.calledTwice
        expect(log.warn.firstCall)
          .to.have.been.calledWithExactly('[ASM] Invalid login provided to eventTrackingV2.trackUserLoginSuccess')
        expect(log.warn.secondCall)
          .to.have.been.calledWithExactly('[ASM] Invalid login provided to eventTrackingV2.trackUserLoginSuccess')
        expect(setUserTags).to.not.have.been.called
        expect(rootSpan.addTags).to.not.have.been.called
        expect(waf.run).to.not.have.been.called
      })

      it('should call to addTags and waf only with login', () => {
        trackUserLoginSuccessV2(tracer, 'login')

        expect(log.warn).to.not.have.been.called
        expect(setUserTags).to.not.have.been.called

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.login': 'login'
        })

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_SUCCESS]: null,
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('should call to setUser, addTags and waf with login and userId', () => {
        trackUserLoginSuccessV2(tracer, 'login', 'userId')

        expect(log.warn).to.not.have.been.called
        expect(setUserTags).to.have.been.calledOnceWithExactly({ id: 'userId' }, rootSpan)

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.id': 'userId',
          'appsec.events.users.login.success.usr.login': 'login'
        })

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_SUCCESS]: null,
            [USER_ID]: 'userId',
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('should call to setUser, addTags and waf with login and user object', () => {
        const user = {
          id: 'userId',
          email: 'email@to.com'
        }

        trackUserLoginSuccessV2(tracer, 'login', user)

        expect(log.warn).to.not.have.been.called
        expect(setUserTags).to.have.been.calledOnceWithExactly(user, rootSpan)

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.id': 'userId',
          'appsec.events.users.login.success.usr.email': 'email@to.com',
          'appsec.events.users.login.success.usr.login': 'login'
        })

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_SUCCESS]: null,
            [USER_ID]: 'userId',
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('should call to addTags and waf with login and metadata', () => {
        const metadata = {
          metakey1: 'metaValue1',
          metakey2: 'metaValue2',
          metakey3: 'metaValue3'
        }

        trackUserLoginSuccessV2(tracer, 'login', null, metadata)

        expect(log.warn).to.not.have.been.called
        expect(setUserTags).to.not.have.been.called

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.login': 'login',
          'appsec.events.users.login.success.metakey1': 'metaValue1',
          'appsec.events.users.login.success.metakey2': 'metaValue2',
          'appsec.events.users.login.success.metakey3': 'metaValue3'
        })

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_SUCCESS]: null,
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('should call to addTags and waf with login, userId and metadata', () => {
        const metadata = {
          metakey1: 'metaValue1',
          metakey2: 'metaValue2',
          metakey3: 'metaValue3'
        }

        trackUserLoginSuccessV2(tracer, 'login', 'userId', metadata)

        expect(log.warn).to.not.have.been.called
        expect(setUserTags).to.have.been.calledOnceWithExactly({
          id: 'userId'
        }, rootSpan)

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.login': 'login',
          'appsec.events.users.login.success.usr.id': 'userId',
          'appsec.events.users.login.success.metakey1': 'metaValue1',
          'appsec.events.users.login.success.metakey2': 'metaValue2',
          'appsec.events.users.login.success.metakey3': 'metaValue3'
        })

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_SUCCESS]: null,
            [USER_ID]: 'userId',
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('Should truncate metadata when depth > 5', () => {
        const metadata = {
          prop1: {
            prop2: {
              prop3: {
                prop4: {
                  data1: 'metavalue1',
                  prop5: {
                    prop6: 'ignored value'
                  }
                }
              }
            }
          },
          prop7: {
            prop8: {
              prop9: {
                prop10: {
                  prop11: {
                    prop12: 'ignored value'
                  }
                }
              }
            }
          },
          arr: [{
            key: 'metavalue2'
          },
          'metavalue3'
          ]
        }

        trackUserLoginSuccessV2(tracer, 'login', null, metadata)

        expect(log.warn).to.have.been.calledOnceWithExactly(
          '[ASM] Too deep object provided in the SDK method %s, object truncated',
          'eventTrackingV2.trackUserLoginSuccess'
        )

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.login': 'login',
          'appsec.events.users.login.success.prop1.prop2.prop3.prop4.data1': 'metavalue1',
          'appsec.events.users.login.success.arr.0.key': 'metavalue2',
          'appsec.events.users.login.success.arr.1': 'metavalue3'
        })
      })

      it('Should ignore undefined properties and set to \'null\' the null values in the metadata', () => {
        const metadata = {
          prop1: undefined,
          prop2: null
        }

        trackUserLoginSuccessV2(tracer, 'login', null, metadata)

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.login': 'login',
          'appsec.events.users.login.success.prop2': 'null'
        })
      })

      it('should keep the trace', () => {
        trackUserLoginSuccessV2(tracer, 'login')

        expect(prioritySampler.setPriority)
          .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, ASM)
      })

      it('should update the metrics', () => {
        trackUserLoginSuccessV2(tracer, 'login')

        expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('login_success', 'v2')
      })
    })

    describe('trackUserLoginFailureV2', () => {
      it('should log warning when root span is not available', () => {
        rootSpan = undefined

        trackUserLoginFailureV2(tracer, 'login', false)

        expect(log.warn)
          .to.have.been.calledOnceWithExactly('[ASM] Root span not available in eventTrackingV2.trackUserLoginFailure')
        expect(setUserTags).to.not.have.been.called
      })

      it('should log warning when passed invalid login', () => {
        trackUserLoginFailureV2(tracer, null, true)
        trackUserLoginFailureV2(tracer, {}, false)

        expect(log.warn).to.have.been.calledTwice
        expect(log.warn.firstCall)
          .to.have.been.calledWithExactly('[ASM] Invalid login provided to eventTrackingV2.trackUserLoginFailure')
        expect(log.warn.secondCall)
          .to.have.been.calledWithExactly('[ASM] Invalid login provided to eventTrackingV2.trackUserLoginFailure')
        expect(setUserTags).to.not.have.been.called
        expect(rootSpan.addTags).to.not.have.been.called
        expect(waf.run).to.not.have.been.called
      })

      it('should call to addTags and waf only with login', () => {
        trackUserLoginFailureV2(tracer, 'login')

        expect(log.warn).to.not.have.been.called
        expect(setUserTags).to.not.have.been.called

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'false'
        })

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_FAILURE]: null,
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('should call to addTags and waf with login and exists=true', () => {
        trackUserLoginFailureV2(tracer, 'login', true)

        expect(log.warn).to.not.have.been.called

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'true'
        })

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_FAILURE]: null,
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('should call to addTags and waf with login and exists=false', () => {
        trackUserLoginFailureV2(tracer, 'login', false)

        expect(log.warn).to.not.have.been.called

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'false'
        })

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_FAILURE]: null,
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('should call to addTags and waf with login and metadata', () => {
        const metadata = {
          metakey1: 'metaValue1',
          metakey2: 'metaValue2',
          metakey3: 'metaValue3'
        }

        trackUserLoginFailureV2(tracer, 'login', metadata)

        expect(log.warn).to.not.have.been.called

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'false',
          'appsec.events.users.login.failure.metakey1': 'metaValue1',
          'appsec.events.users.login.failure.metakey2': 'metaValue2',
          'appsec.events.users.login.failure.metakey3': 'metaValue3'
        })

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_FAILURE]: null,
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('should call to addTags and waf with login, exists and metadata', () => {
        const metadata = {
          metakey1: 'metaValue1',
          metakey2: 'metaValue2',
          metakey3: 'metaValue3'
        }

        trackUserLoginFailureV2(tracer, 'login', true, metadata)

        expect(log.warn).to.not.have.been.called

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'true',
          'appsec.events.users.login.failure.metakey1': 'metaValue1',
          'appsec.events.users.login.failure.metakey2': 'metaValue2',
          'appsec.events.users.login.failure.metakey3': 'metaValue3'
        })

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_FAILURE]: null,
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('Should truncate metadata when depth > 5', () => {
        const metadata = {
          prop1: {
            prop2: {
              prop3: {
                prop4: {
                  data1: 'metavalue1',
                  prop5: {
                    prop6: 'ignored value'
                  }
                }
              }
            }
          },
          prop7: {
            prop8: {
              prop9: {
                prop10: {
                  prop11: {
                    prop12: 'ignored value'
                  }
                }
              }
            }
          },
          arr: [{
            key: 'metavalue2'
          },
          'metavalue3'
          ]
        }

        trackUserLoginFailureV2(tracer, 'login', false, metadata)

        expect(log.warn).to.have.been.calledOnceWithExactly(
          '[ASM] Too deep object provided in the SDK method %s, object truncated',
          'eventTrackingV2.trackUserLoginFailure'
        )

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'false',
          'appsec.events.users.login.failure.prop1.prop2.prop3.prop4.data1': 'metavalue1',
          'appsec.events.users.login.failure.arr.0.key': 'metavalue2',
          'appsec.events.users.login.failure.arr.1': 'metavalue3'
        })
      })

      it('Should ignore undefined properties and set to \'null\' the null values in the metadata', () => {
        const metadata = {
          prop1: undefined,
          prop2: null
        }

        trackUserLoginFailureV2(tracer, 'login', true, metadata)

        expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'true',
          'appsec.events.users.login.failure.prop2': 'null'
        })
      })

      it('should keep the trace', () => {
        trackUserLoginFailureV2(tracer, 'login', true)

        expect(prioritySampler.setPriority)
          .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, ASM)
      })

      it('should update the metrics', () => {
        trackUserLoginFailureV2(tracer, 'login', true)

        expect(telemetry.incrementSdkEventMetric).to.have.been.calledWithExactly('login_failure', 'v2')
      })
    })
  })
})
