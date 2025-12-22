'use strict'

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

      sinon.assert.calledTwice(log.warn)
      sinon.assert.calledWithExactly(log.warn.firstCall, '[ASM] Invalid user provided to trackUserLoginSuccessEvent')
      sinon.assert.calledWithExactly(log.warn.secondCall, '[ASM] Invalid user provided to trackUserLoginSuccessEvent')
      sinon.assert.notCalled(setUserTags)
      sinon.assert.notCalled(rootSpan.addTags)
      sinon.assert.notCalled(telemetry.incrementSdkEventMetric)
    })

    it('should log warning when root span is not available', () => {
      rootSpan = undefined

      trackUserLoginSuccessEvent(tracer, { id: 'user_id' }, { key: 'value' })

      sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Root span not available in trackUserLoginSuccessEvent')
      sinon.assert.notCalled(setUserTags)
      sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'login_success', 'v1')
    })

    it('should call setUser and addTags with metadata', () => {
      const user = { id: 'user_id' }

      trackUserLoginSuccessEvent(tracer, user, {
        metakey1: 'metaValue1',
        metakey2: 'metaValue2',
        metakey3: 'metaValue3'
      })

      sinon.assert.notCalled(log.warn)
      sinon.assert.calledOnceWithExactly(setUserTags, user, rootSpan)
      sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
        'appsec.events.users.login.success.track': 'true',
        '_dd.appsec.events.users.login.success.sdk': 'true',
        'appsec.events.users.login.success.usr.login': 'user_id',
        'appsec.events.users.login.success.metakey1': 'metaValue1',
        'appsec.events.users.login.success.metakey2': 'metaValue2',
        'appsec.events.users.login.success.metakey3': 'metaValue3'
      })
      sinon.assert.calledOnceWithExactly(prioritySampler.setPriority, rootSpan, USER_KEEP, ASM)
      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          [LOGIN_SUCCESS]: null,
          [USER_ID]: 'user_id',
          [USER_LOGIN]: 'user_id'
        }
      })
      sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'login_success', 'v1')
    })

    it('should call setUser and addTags without metadata', () => {
      const user = { id: 'user_id' }

      trackUserLoginSuccessEvent(tracer, user)

      sinon.assert.notCalled(log.warn)
      sinon.assert.calledOnceWithExactly(setUserTags, user, rootSpan)
      sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
        'appsec.events.users.login.success.track': 'true',
        '_dd.appsec.events.users.login.success.sdk': 'true',
        'appsec.events.users.login.success.usr.login': 'user_id'
      })
      sinon.assert.calledOnceWithExactly(prioritySampler.setPriority, rootSpan, USER_KEEP, ASM)
      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          [LOGIN_SUCCESS]: null,
          [USER_ID]: 'user_id',
          [USER_LOGIN]: 'user_id'
        }
      })
      sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'login_success', 'v1')
    })

    it('should call waf with user login', () => {
      const user = { id: 'user_id', login: 'user_login' }

      trackUserLoginSuccessEvent(tracer, user)

      sinon.assert.notCalled(log.warn)
      sinon.assert.calledOnceWithExactly(setUserTags, user, rootSpan)
      sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
        'appsec.events.users.login.success.track': 'true',
        '_dd.appsec.events.users.login.success.sdk': 'true',
        'appsec.events.users.login.success.usr.login': 'user_login'
      })
      sinon.assert.calledOnceWithExactly(prioritySampler.setPriority, rootSpan, USER_KEEP, ASM)
      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          [LOGIN_SUCCESS]: null,
          [USER_ID]: 'user_id',
          [USER_LOGIN]: 'user_login'
        }
      })
      sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'login_success', 'v1')
    })
  })

  describe('trackUserLoginFailureEvent', () => {
    it('should log warning when passed invalid userId', () => {
      trackUserLoginFailureEvent(tracer, null, false, { key: 'value' })
      trackUserLoginFailureEvent(tracer, [], false, { key: 'value' })

      sinon.assert.calledTwice(log.warn)
      sinon.assert.calledWithExactly(log.warn.firstCall, '[ASM] Invalid userId provided to trackUserLoginFailureEvent')
      sinon.assert.calledWithExactly(log.warn.secondCall, '[ASM] Invalid userId provided to trackUserLoginFailureEvent')
      sinon.assert.notCalled(setUserTags)
      sinon.assert.notCalled(rootSpan.addTags)
      sinon.assert.notCalled(telemetry.incrementSdkEventMetric)
    })

    it('should log warning when root span is not available', () => {
      rootSpan = undefined

      trackUserLoginFailureEvent(tracer, 'user_id', false, { key: 'value' })

      sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Root span not available in %s', 'trackUserLoginFailureEvent')
      sinon.assert.notCalled(setUserTags)
      sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'login_failure', 'v1')
    })

    it('should call addTags with metadata', () => {
      trackUserLoginFailureEvent(tracer, 'user_id', true, {
        metakey1: 'metaValue1',
        metakey2: 'metaValue2',
        metakey3: 'metaValue3'
      })

      sinon.assert.notCalled(log.warn)
      sinon.assert.notCalled(setUserTags)
      sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
        'appsec.events.users.login.failure.track': 'true',
        '_dd.appsec.events.users.login.failure.sdk': 'true',
        'appsec.events.users.login.failure.usr.id': 'user_id',
        'appsec.events.users.login.failure.usr.login': 'user_id',
        'appsec.events.users.login.failure.usr.exists': 'true',
        'appsec.events.users.login.failure.metakey1': 'metaValue1',
        'appsec.events.users.login.failure.metakey2': 'metaValue2',
        'appsec.events.users.login.failure.metakey3': 'metaValue3'
      })
      sinon.assert.calledOnceWithExactly(prioritySampler.setPriority, rootSpan, USER_KEEP, ASM)
      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          [LOGIN_FAILURE]: null,
          [USER_LOGIN]: 'user_id'
        }
      })
      sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'login_failure', 'v1')
    })

    it('should send false `usr.exists` property when the user does not exist', () => {
      trackUserLoginFailureEvent(tracer, 'user_id', false, {
        metakey1: 'metaValue1',
        metakey2: 'metaValue2',
        metakey3: 'metaValue3'
      })

      sinon.assert.notCalled(log.warn)
      sinon.assert.notCalled(setUserTags)
      sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
        'appsec.events.users.login.failure.track': 'true',
        '_dd.appsec.events.users.login.failure.sdk': 'true',
        'appsec.events.users.login.failure.usr.id': 'user_id',
        'appsec.events.users.login.failure.usr.login': 'user_id',
        'appsec.events.users.login.failure.usr.exists': 'false',
        'appsec.events.users.login.failure.metakey1': 'metaValue1',
        'appsec.events.users.login.failure.metakey2': 'metaValue2',
        'appsec.events.users.login.failure.metakey3': 'metaValue3'
      })
      sinon.assert.calledOnceWithExactly(prioritySampler.setPriority, rootSpan, USER_KEEP, ASM)
      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          [LOGIN_FAILURE]: null,
          [USER_LOGIN]: 'user_id'
        }
      })
      sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'login_failure', 'v1')
    })

    it('should call addTags without metadata', () => {
      trackUserLoginFailureEvent(tracer, 'user_id', true)

      sinon.assert.notCalled(log.warn)
      sinon.assert.notCalled(setUserTags)
      sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
        'appsec.events.users.login.failure.track': 'true',
        '_dd.appsec.events.users.login.failure.sdk': 'true',
        'appsec.events.users.login.failure.usr.id': 'user_id',
        'appsec.events.users.login.failure.usr.login': 'user_id',
        'appsec.events.users.login.failure.usr.exists': 'true'
      })
      sinon.assert.calledOnceWithExactly(prioritySampler.setPriority, rootSpan, USER_KEEP, ASM)
      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          [LOGIN_FAILURE]: null,
          [USER_LOGIN]: 'user_id'
        }
      })
      sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'login_failure', 'v1')
    })
  })

  describe('trackCustomEvent', () => {
    it('should log warning when passed invalid eventName', () => {
      trackCustomEvent(tracer, null)
      trackCustomEvent(tracer, { name: 'name' })

      sinon.assert.calledTwice(log.warn)
      sinon.assert.calledWithExactly(log.warn.firstCall, '[ASM] Invalid eventName provided to trackCustomEvent')
      sinon.assert.calledWithExactly(log.warn.secondCall, '[ASM] Invalid eventName provided to trackCustomEvent')
      sinon.assert.notCalled(setUserTags)
      sinon.assert.notCalled(rootSpan.addTags)
      sinon.assert.notCalled(telemetry.incrementSdkEventMetric)
    })

    it('should log warning when root span is not available', () => {
      rootSpan = undefined

      trackCustomEvent(tracer, 'custom_event')

      sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Root span not available in %s', 'trackCustomEvent')
      sinon.assert.notCalled(setUserTags)
      sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'custom', 'v1')
    })

    it('should call addTags with metadata', () => {
      trackCustomEvent(tracer, 'custom_event', {
        metaKey1: 'metaValue1',
        metakey2: 'metaValue2'
      })

      sinon.assert.notCalled(log.warn)
      sinon.assert.notCalled(setUserTags)
      sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
        'appsec.events.custom_event.track': 'true',
        '_dd.appsec.events.custom_event.sdk': 'true',
        'appsec.events.custom_event.metaKey1': 'metaValue1',
        'appsec.events.custom_event.metakey2': 'metaValue2'
      })
      sinon.assert.calledOnceWithExactly(prioritySampler.setPriority, rootSpan, USER_KEEP, ASM)
      sinon.assert.notCalled(waf.run)
      sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'custom', 'v1')
    })

    it('should call addTags without metadata', () => {
      trackCustomEvent(tracer, 'custom_event')

      sinon.assert.notCalled(log.warn)
      sinon.assert.notCalled(setUserTags)
      sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
        'appsec.events.custom_event.track': 'true',
        '_dd.appsec.events.custom_event.sdk': 'true'
      })
      sinon.assert.notCalled(waf.run)
      sinon.assert.calledOnceWithExactly(prioritySampler.setPriority, rootSpan, USER_KEEP, ASM)
      sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'custom', 'v1')
    })

    it('should call to the waf when event name is "users.login.success"', () => {
      trackCustomEvent(tracer, 'users.login.success')

      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          [LOGIN_SUCCESS]: null
        }
      })
    })

    it('should call to the waf when event name is "users.login.failure"', () => {
      trackCustomEvent(tracer, 'users.login.failure')

      sinon.assert.calledOnceWithExactly(waf.run, {
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

        sinon.assert.calledOnceWithExactly(
          log.warn,
          '[ASM] Root span not available in eventTrackingV2.trackUserLoginSuccess'
        )
        sinon.assert.notCalled(setUserTags)
      })

      it('should log warning when passed invalid login', () => {
        trackUserLoginSuccessV2(tracer, null)
        trackUserLoginSuccessV2(tracer, {})

        sinon.assert.calledTwice(log.warn)
        sinon.assert.calledWithExactly(
          log.warn.firstCall,
          '[ASM] Invalid login provided to eventTrackingV2.trackUserLoginSuccess'
        )
        sinon.assert.calledWithExactly(
          log.warn.secondCall,
          '[ASM] Invalid login provided to eventTrackingV2.trackUserLoginSuccess'
        )
        sinon.assert.notCalled(setUserTags)
        sinon.assert.notCalled(rootSpan.addTags)
        sinon.assert.notCalled(waf.run)
      })

      it('should call to addTags and waf only with login', () => {
        trackUserLoginSuccessV2(tracer, 'login')

        sinon.assert.notCalled(log.warn)
        sinon.assert.notCalled(setUserTags)

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.login': 'login'
        })

        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            [LOGIN_SUCCESS]: null,
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('should call to setUser, addTags and waf with login and userId', () => {
        trackUserLoginSuccessV2(tracer, 'login', 'userId')

        sinon.assert.notCalled(log.warn)
        sinon.assert.calledOnceWithExactly(setUserTags, { id: 'userId' }, rootSpan)

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.id': 'userId',
          'appsec.events.users.login.success.usr.login': 'login'
        })

        sinon.assert.calledOnceWithExactly(waf.run, {
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

        sinon.assert.notCalled(log.warn)
        sinon.assert.calledOnceWithExactly(setUserTags, user, rootSpan)

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.id': 'userId',
          'appsec.events.users.login.success.usr.email': 'email@to.com',
          'appsec.events.users.login.success.usr.login': 'login'
        })

        sinon.assert.calledOnceWithExactly(waf.run, {
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

        sinon.assert.notCalled(log.warn)
        sinon.assert.notCalled(setUserTags)

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.login': 'login',
          'appsec.events.users.login.success.metakey1': 'metaValue1',
          'appsec.events.users.login.success.metakey2': 'metaValue2',
          'appsec.events.users.login.success.metakey3': 'metaValue3'
        })

        sinon.assert.calledOnceWithExactly(waf.run, {
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

        sinon.assert.notCalled(log.warn)
        sinon.assert.calledOnceWithExactly(setUserTags, {
          id: 'userId'
        }, rootSpan)

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.login': 'login',
          'appsec.events.users.login.success.usr.id': 'userId',
          'appsec.events.users.login.success.metakey1': 'metaValue1',
          'appsec.events.users.login.success.metakey2': 'metaValue2',
          'appsec.events.users.login.success.metakey3': 'metaValue3'
        })

        sinon.assert.calledOnceWithExactly(waf.run, {
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

        sinon.assert.calledOnceWithExactly(log.warn,
          '[ASM] Too deep object provided in the SDK method %s, object truncated',
          'eventTrackingV2.trackUserLoginSuccess'
        )

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
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

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.login': 'login',
          'appsec.events.users.login.success.prop2': 'null'
        })
      })

      it('should keep the trace', () => {
        trackUserLoginSuccessV2(tracer, 'login')

        sinon.assert.calledOnceWithExactly(prioritySampler.setPriority, rootSpan, USER_KEEP, ASM)
      })

      it('should update the metrics', () => {
        trackUserLoginSuccessV2(tracer, 'login')

        sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'login_success', 'v2')
      })
    })

    describe('trackUserLoginFailureV2', () => {
      it('should log warning when root span is not available', () => {
        rootSpan = undefined

        trackUserLoginFailureV2(tracer, 'login', false)

        sinon.assert.calledOnceWithExactly(
          log.warn,
          '[ASM] Root span not available in eventTrackingV2.trackUserLoginFailure'
        )
        sinon.assert.notCalled(setUserTags)
      })

      it('should log warning when passed invalid login', () => {
        trackUserLoginFailureV2(tracer, null, true)
        trackUserLoginFailureV2(tracer, {}, false)

        sinon.assert.calledTwice(log.warn)
        sinon.assert.calledWithExactly(
          log.warn.firstCall,
          '[ASM] Invalid login provided to eventTrackingV2.trackUserLoginFailure'
        )
        sinon.assert.calledWithExactly(
          log.warn.secondCall,
          '[ASM] Invalid login provided to eventTrackingV2.trackUserLoginFailure'
        )
        sinon.assert.notCalled(setUserTags)
        sinon.assert.notCalled(rootSpan.addTags)
        sinon.assert.notCalled(waf.run)
      })

      it('should call to addTags and waf only with login', () => {
        trackUserLoginFailureV2(tracer, 'login')

        sinon.assert.notCalled(log.warn)
        sinon.assert.notCalled(setUserTags)

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'false'
        })

        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            [LOGIN_FAILURE]: null,
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('should call to addTags and waf with login and exists=true', () => {
        trackUserLoginFailureV2(tracer, 'login', true)

        sinon.assert.notCalled(log.warn)

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'true'
        })

        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            [LOGIN_FAILURE]: null,
            [USER_LOGIN]: 'login'
          }
        })
      })

      it('should call to addTags and waf with login and exists=false', () => {
        trackUserLoginFailureV2(tracer, 'login', false)

        sinon.assert.notCalled(log.warn)

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'false'
        })

        sinon.assert.calledOnceWithExactly(waf.run, {
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

        sinon.assert.notCalled(log.warn)

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'false',
          'appsec.events.users.login.failure.metakey1': 'metaValue1',
          'appsec.events.users.login.failure.metakey2': 'metaValue2',
          'appsec.events.users.login.failure.metakey3': 'metaValue3'
        })

        sinon.assert.calledOnceWithExactly(waf.run, {
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

        sinon.assert.notCalled(log.warn)

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'true',
          'appsec.events.users.login.failure.metakey1': 'metaValue1',
          'appsec.events.users.login.failure.metakey2': 'metaValue2',
          'appsec.events.users.login.failure.metakey3': 'metaValue3'
        })

        sinon.assert.calledOnceWithExactly(waf.run, {
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

        sinon.assert.calledOnceWithExactly(log.warn,
          '[ASM] Too deep object provided in the SDK method %s, object truncated',
          'eventTrackingV2.trackUserLoginFailure'
        )

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
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

        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'login',
          'appsec.events.users.login.failure.usr.exists': 'true',
          'appsec.events.users.login.failure.prop2': 'null'
        })
      })

      it('should keep the trace', () => {
        trackUserLoginFailureV2(tracer, 'login', true)

        sinon.assert.calledOnceWithExactly(prioritySampler.setPriority, rootSpan, USER_KEEP, ASM)
      })

      it('should update the metrics', () => {
        trackUserLoginFailureV2(tracer, 'login', true)

        sinon.assert.calledWithExactly(telemetry.incrementSdkEventMetric, 'login_failure', 'v2')
      })
    })
  })
})
