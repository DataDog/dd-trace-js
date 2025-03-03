'use strict'

const proxyquire = require('proxyquire')
const agent = require('../../plugins/agent')
const axios = require('axios')
const tracer = require('../../../../../index')
const { LOGIN_SUCCESS, LOGIN_FAILURE, USER_ID, USER_LOGIN } = require('../../../src/appsec/addresses')
const { SAMPLING_MECHANISM_APPSEC } = require('../../../src/constants')
const { USER_KEEP } = require('../../../../../ext/priority')

describe('track_event', () => {
  describe('Internal API', () => {
    const tracer = {}
    let log
    let prioritySampler
    let rootSpan
    let getRootSpan
    let setUserTags
    let sample
    let waf
    let telemetryMetrics, count, inc
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

      sample = sinon.stub()

      inc = sinon.stub()

      count = sinon.stub().callsFake(() => {
        return {
          inc
        }
      })

      telemetryMetrics = {
        manager: {
          namespace: function (name) {
            if (name === 'appsec') {
              return {
                count
              }
            }

            return null
          }
        }
      }

      waf = {
        run: sinon.spy()
      }

      const trackEvents = proxyquire('../../../src/appsec/sdk/track_event', {
        '../../log': log,
        './utils': {
          getRootSpan
        },
        './set_user': {
          setUserTags
        },
        '../standalone': {
          sample
        },
        '../waf': waf,
        '../../telemetry/metrics': telemetryMetrics
      })

      trackUserLoginSuccessEvent = trackEvents.trackUserLoginSuccessEvent
      trackUserLoginSuccessV2 = trackEvents.trackUserLoginSuccessV2
      trackUserLoginFailureV2 = trackEvents.trackUserLoginFailureV2
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
      })

      it('should log warning when root span is not available', () => {
        rootSpan = undefined

        trackUserLoginSuccessEvent(tracer, { id: 'user_id' }, { key: 'value' })

        expect(log.warn)
          .to.have.been.calledOnceWithExactly('[ASM] Root span not available in trackUserLoginSuccessEvent')
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
          .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
        expect(sample).to.have.been.calledOnceWithExactly(rootSpan)
        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_SUCCESS]: null,
            [USER_ID]: 'user_id',
            [USER_LOGIN]: 'user_id'
          }
        })
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
          .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
        expect(sample).to.have.been.calledOnceWithExactly(rootSpan)
        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_SUCCESS]: null,
            [USER_ID]: 'user_id',
            [USER_LOGIN]: 'user_id'
          }
        })
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
          .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
        expect(sample).to.have.been.calledOnceWithExactly(rootSpan)
        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_SUCCESS]: null,
            [USER_ID]: 'user_id',
            [USER_LOGIN]: 'user_login'
          }
        })
      })

      it('should increase metrics for "sdk.event" for v1', () => {
        const user = { id: 'user_id', login: 'user_login' }

        trackUserLoginSuccessEvent(tracer, user)

        expect(count).to.have.been.calledOnceWithExactly('sdk.event', {
          event_type: 'login_success',
          sdk_version: 'v1'
        })
        expect(inc).to.have.been.calledOnceWithExactly(1)
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
      })

      it('should log warning when root span is not available', () => {
        rootSpan = undefined

        trackUserLoginFailureEvent(tracer, 'user_id', false, { key: 'value' })

        expect(log.warn)
          .to.have.been.calledOnceWithExactly('[ASM] Root span not available in %s', 'trackUserLoginFailureEvent')
        expect(setUserTags).to.not.have.been.called
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
          .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
        expect(sample).to.have.been.calledOnceWithExactly(rootSpan)
        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_FAILURE]: null,
            [USER_LOGIN]: 'user_id'
          }
        })
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
          .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
        expect(sample).to.have.been.calledOnceWithExactly(rootSpan)
        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_FAILURE]: null,
            [USER_LOGIN]: 'user_id'
          }
        })
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
          .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
        expect(sample).to.have.been.calledOnceWithExactly(rootSpan)
        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            [LOGIN_FAILURE]: null,
            [USER_LOGIN]: 'user_id'
          }
        })
      })

      it('should increase metrics for "sdk.event" for v1', () => {
        trackUserLoginFailureEvent(tracer, 'user_id', true)

        expect(count).to.have.been.calledOnceWithExactly('sdk.event', {
          event_type: 'login_failure',
          sdk_version: 'v1'
        })
        expect(inc).to.have.been.calledOnceWithExactly(1)
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
      })

      it('should log warning when root span is not available', () => {
        rootSpan = undefined

        trackCustomEvent(tracer, 'custom_event')

        expect(log.warn)
          .to.have.been.calledOnceWithExactly('[ASM] Root span not available in %s', 'trackCustomEvent')
        expect(setUserTags).to.not.have.been.called
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
          .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
        expect(sample).to.have.been.calledOnceWithExactly(rootSpan)
        expect(waf.run).to.not.have.been.called
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
          .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
        expect(sample).to.have.been.calledOnceWithExactly(rootSpan)
      })

      it('should increase metrics for "sdk.event" for v1', () => {
        trackCustomEvent(tracer, 'custom_event')

        expect(count).to.have.been.calledOnceWithExactly('sdk.event', {
          event_type: 'custom',
          sdk_version: 'v1'
        })
        expect(inc).to.have.been.calledOnceWithExactly(1)
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

    describe('v2', () => {
      describe('trackUserLoginSuccessV2', () => {
        it('should log warning when root span is not available', () => {
          rootSpan = undefined

          trackUserLoginSuccessV2(tracer, 'login')

          expect(log.warn)
            .to.have.been.calledOnceWithExactly('[ASM] Root span not available in v2.trackUserLoginSuccess')
          expect(setUserTags).to.not.have.been.called
        })

        it('should log warning when passed invalid login', () => {
          trackUserLoginSuccessV2(tracer, null)
          trackUserLoginSuccessV2(tracer, {})

          expect(log.warn).to.have.been.calledTwice
          expect(log.warn.firstCall)
            .to.have.been.calledWithExactly('[ASM] Invalid login provided to v2.trackUserLoginSuccess')
          expect(log.warn.secondCall)
            .to.have.been.calledWithExactly('[ASM] Invalid login provided to v2.trackUserLoginSuccess')
          expect(setUserTags).to.not.have.been.called
          expect(rootSpan.addTags).to.not.have.been.called
          expect(waf.run).to.not.have.been.called
        })

        it('should call to addTags and waf only with login', () => {
          trackUserLoginSuccessV2(tracer, 'login')

          expect(log.warn).to.not.have.been.called
          expect(setUserTags).to.not.have.been.called

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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
            arr: [
              {
                key: 'metavalue2'
              },
              'metavalue3'
            ]
          }

          trackUserLoginSuccessV2(tracer, 'login', null, metadata)

          expect(log.warn).to.have.been.calledOnceWithExactly(
            '[ASM] Too deep object provided in the SDK method %s, object truncated',
            'v2.trackUserLoginSuccess'
          )

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
              'appsec.events.users.login.success.track': 'true',
              '_dd.appsec.events.users.login.success.sdk': 'true',
              'appsec.events.users.login.success.usr.login': 'login',
              'appsec.events.users.login.success.prop2': 'null'
            })
        })

        it('should keep the trace', () => {
          trackUserLoginSuccessV2(tracer, 'login')

          expect(prioritySampler.setPriority)
            .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
          expect(sample).to.have.been.calledOnceWithExactly(rootSpan)
        })

        it('should update the metrics', () => {
          trackUserLoginSuccessV2(tracer, 'login')

          expect(count).to.have.been.calledOnceWithExactly('sdk.event', {
            event_type: 'login_success',
            sdk_version: 'v2'
          })
          expect(inc).to.have.been.calledOnceWithExactly(1)
        })
      })

      describe('trackUserLoginFailureV2', () => {
        it('should log warning when root span is not available', () => {
          rootSpan = undefined

          trackUserLoginFailureV2(tracer, 'login', false)

          expect(log.warn)
            .to.have.been.calledOnceWithExactly('[ASM] Root span not available in v2.trackUserLoginFailure')
          expect(setUserTags).to.not.have.been.called
        })

        it('should log warning when passed invalid login', () => {
          trackUserLoginFailureV2(tracer, null, true)
          trackUserLoginFailureV2(tracer, {}, false)

          expect(log.warn).to.have.been.calledTwice
          expect(log.warn.firstCall)
            .to.have.been.calledWithExactly('[ASM] Invalid login provided to v2.trackUserLoginFailure')
          expect(log.warn.secondCall)
            .to.have.been.calledWithExactly('[ASM] Invalid login provided to v2.trackUserLoginFailure')
          expect(setUserTags).to.not.have.been.called
          expect(rootSpan.addTags).to.not.have.been.called
          expect(waf.run).to.not.have.been.called
        })

        it('should call to addTags and waf only with login', () => {
          trackUserLoginFailureV2(tracer, 'login')

          expect(log.warn).to.not.have.been.called
          expect(setUserTags).to.not.have.been.called

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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
            arr: [
              {
                key: 'metavalue2'
              },
              'metavalue3'
            ]
          }

          trackUserLoginFailureV2(tracer, 'login', false, metadata)

          expect(log.warn).to.have.been.calledOnceWithExactly(
            '[ASM] Too deep object provided in the SDK method %s, object truncated',
            'v2.trackUserLoginFailure'
          )

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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

          expect(rootSpan.addTags).to.have.been.calledOnceWithExactly(
            {
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
            .to.have.been.calledOnceWithExactly(rootSpan, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
          expect(sample).to.have.been.calledOnceWithExactly(rootSpan)
        })

        it('should update the metrics', () => {
          trackUserLoginFailureV2(tracer, 'login', true)

          expect(count).to.have.been.calledOnceWithExactly('sdk.event', {
            event_type: 'login_failure',
            sdk_version: 'v2'
          })
          expect(inc).to.have.been.calledOnceWithExactly(1)
        })
      })
    })
  })

  describe('Integration with the tracer', () => {
    let http
    let controller
    let appListener
    let port

    function listener (req, res) {
      if (controller) {
        controller(req, res)
      }
    }

    before(async () => {
      await agent.load('http')
      http = require('http')
    })

    before(done => {
      const server = new http.Server(listener)
      appListener = server
        .listen(port, 'localhost', () => {
          port = appListener.address().port
          done()
        })
    })

    after(() => {
      appListener.close()
      return agent.close({ ritmReset: false })
    })

    describe('trackUserLoginSuccessEvent', () => {
      it('should track valid user', (done) => {
        controller = (req, res) => {
          tracer.appsec.trackUserLoginSuccessEvent({
            id: 'test_user_id'
          }, { metakey: 'metaValue' })
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('appsec.events.users.login.success.track', 'true')
          expect(traces[0][0].meta).to.have.property('usr.id', 'test_user_id')
          expect(traces[0][0].meta).to.have.property('appsec.events.users.login.success.metakey', 'metaValue')
          expect(traces[0][0].metrics).to.have.property('_sampling_priority_v1', USER_KEEP)
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not track without user', (done) => {
        controller = (req, res) => {
          tracer.appsec.trackUserLoginSuccessEvent(undefined, { metakey: 'metaValue' })
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.not.have.property('appsec.events.users.login.success.track', 'true')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not track without calling the sdk method', (done) => {
        controller = (req, res) => {
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.not.have.property('appsec.events.users.login.success.track', 'true')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })
    })

    describe('trackUserLoginFailureEvent', () => {
      it('should track valid existing user', (done) => {
        controller = (req, res) => {
          tracer.appsec.trackUserLoginFailureEvent('test_user_id', true, { metakey: 'metaValue' })
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('appsec.events.users.login.failure.track', 'true')
          expect(traces[0][0].meta).to.have.property('appsec.events.users.login.failure.usr.id', 'test_user_id')
          expect(traces[0][0].meta).to.have.property('appsec.events.users.login.failure.usr.exists', 'true')
          expect(traces[0][0].meta).to.have.property('appsec.events.users.login.failure.metakey', 'metaValue')
          expect(traces[0][0].metrics).to.have.property('_sampling_priority_v1', USER_KEEP)
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should track valid non existing user', (done) => {
        controller = (req, res) => {
          tracer.appsec.trackUserLoginFailureEvent('test_user_id', false, { metakey: 'metaValue' })
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('appsec.events.users.login.failure.track', 'true')
          expect(traces[0][0].meta).to.have.property('appsec.events.users.login.failure.usr.id', 'test_user_id')
          expect(traces[0][0].meta).to.have.property('appsec.events.users.login.failure.usr.exists', 'false')
          expect(traces[0][0].meta).to.have.property('appsec.events.users.login.failure.metakey', 'metaValue')
          expect(traces[0][0].metrics).to.have.property('_sampling_priority_v1', USER_KEEP)
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not track without user', (done) => {
        controller = (req, res) => {
          tracer.appsec.trackUserLoginFailureEvent(undefined, false, { metakey: 'metaValue' })
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.not.have.property('appsec.events.users.login.failure.track', 'true')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not track without calling the sdk method', (done) => {
        controller = (req, res) => {
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.not.have.property('appsec.events.users.login.failure.track', 'true')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })
    })

    describe('trackCustomEvent', () => {
      it('should track valid event name', (done) => {
        controller = (req, res) => {
          tracer.appsec.trackCustomEvent('my-custom-event', { metakey: 'metaValue' })
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('appsec.events.my-custom-event.track', 'true')
          expect(traces[0][0].meta).to.have.property('appsec.events.my-custom-event.metakey', 'metaValue')
          expect(traces[0][0].metrics).to.have.property('_sampling_priority_v1', USER_KEEP)
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not track invalid event name', (done) => {
        controller = (req, res) => {
          tracer.appsec.trackCustomEvent(null, { metakey: 'metaValue' })
          tracer.appsec.trackCustomEvent({ event: 'name' }, { metakey: 'metaValue' })
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].metrics).to.not.have.property('_sampling_priority_v1', USER_KEEP)
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })
    })
  })
})
