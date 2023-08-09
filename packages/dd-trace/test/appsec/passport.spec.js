'use strict'

const proxyquire = require('proxyquire')

describe('Passport', () => {
  const rootSpan = {
    context: () => { return {} }
  }
  const loginLocal = { type: 'local', username: 'test' }
  const userUuid = {
    id: '591dc126-8431-4d0f-9509-b23318d3dce4',
    email: 'testUser@test.com',
    username: 'Test User'
  }

  let passportModule, log, events, setUser
  beforeEach(() => {
    rootSpan.context = () => { return {} }

    log = {
      warn: sinon.stub()
    }

    events = {
      trackEvent: sinon.stub()
    }

    setUser = {
      setUserTags: sinon.stub()
    }

    passportModule = proxyquire('../../src/appsec/passport', {
      '../log': log,
      './sdk/track_event': events,
      './sdk/set_user': setUser
    })
  })

  describe('passportTrackEvent', () => {
    it('should call log when credentials is undefined', () => {
      passportModule.passportTrackEvent(undefined, undefined, undefined, 'safe')

      expect(log.warn).to.have.been.calledOnceWithExactly('No user ID found in authentication instrumentation')
    })

    it('should call log when type is not known', () => {
      const credentials = { type: 'unknown', username: 'test' }

      passportModule.passportTrackEvent(credentials, undefined, undefined, 'safe')

      expect(log.warn).to.have.been.calledOnceWithExactly('No user ID found in authentication instrumentation')
    })

    it('should call log when type is known but username not present', () => {
      const credentials = { type: 'http' }

      passportModule.passportTrackEvent(credentials, undefined, undefined, 'safe')

      expect(log.warn).to.have.been.calledOnceWithExactly('No user ID found in authentication instrumentation')
    })

    it('should report login failure when passportUser is not present', () => {
      passportModule.passportTrackEvent(loginLocal, undefined, undefined, 'safe')

      expect(setUser.setUserTags).not.to.have.been.called
      expect(events.trackEvent).to.have.been.calledOnceWithExactly(
        'users.login.failure',
        { 'usr.id': '' },
        'passportTrackEvent',
        undefined,
        'safe'
      )
    })

    it('should report login success when passportUser is present', () => {
      passportModule.passportTrackEvent(loginLocal, userUuid, rootSpan, 'safe')

      expect(setUser.setUserTags).to.have.been.calledOnceWithExactly({ id: userUuid.id }, rootSpan)
      expect(events.trackEvent).to.have.been.calledOnceWithExactly(
        'users.login.success',
        null,
        'passportTrackEvent',
        rootSpan,
        'safe'
      )
    })

    it('should report login success and blank id in safe mode when id is not a uuid', () => {
      const user = {
        id: 'publicName',
        email: 'testUser@test.com',
        username: 'Test User'
      }
      passportModule.passportTrackEvent(loginLocal, user, rootSpan, 'safe')

      expect(setUser.setUserTags).to.have.been.calledOnceWithExactly({ id: '' }, rootSpan)
      expect(events.trackEvent).to.have.been.calledOnceWithExactly(
        'users.login.success',
        null,
        'passportTrackEvent',
        rootSpan,
        'safe'
      )
    })

    it('should report login success and the extended fields in extended mode', () => {
      const user = {
        id: 'publicName',
        email: 'testUser@test.com',
        username: 'Test User'
      }

      passportModule.passportTrackEvent(loginLocal, user, rootSpan, 'extended')
      expect(setUser.setUserTags).to.have.been.calledOnceWithExactly(
        {
          id: 'publicName',
          login: 'test',
          email: 'testUser@test.com',
          username: 'Test User'
        },
        rootSpan
      )
      expect(events.trackEvent).to.have.been.calledOnceWithExactly(
        'users.login.success',
        null,
        'passportTrackEvent',
        rootSpan,
        'extended'
      )
    })

    it('should not call trackEvent in safe mode if sdk user event functions are already called', () => {
      rootSpan.context = () => {
        return {
          _tags: {
            '_dd.appsec.events.users.login.success.sdk': 'true'
          }
        }
      }

      passportModule.passportTrackEvent(loginLocal, userUuid, rootSpan, 'safe')
      expect(setUser.setUserTags).not.to.have.been.called
      expect(events.trackEvent).not.to.have.been.called
    })

    it('should not call trackEvent in extended mode if trackUserLoginSuccessEvent is already called', () => {
      rootSpan.context = () => {
        return {
          _tags: {
            '_dd.appsec.events.users.login.success.sdk': 'true'
          }
        }
      }

      passportModule.passportTrackEvent(loginLocal, userUuid, rootSpan, 'extended')
      expect(setUser.setUserTags).not.to.have.been.called
      expect(events.trackEvent).not.to.have.been.called
    })

    it('should call trackEvent in extended mode if trackCustomEvent function is already called', () => {
      rootSpan.context = () => {
        return {
          _tags: {
            '_dd.appsec.events.custom.event.sdk': 'true'
          }
        }
      }

      passportModule.passportTrackEvent(loginLocal, userUuid, rootSpan, 'extended')
      expect(events.trackEvent).to.have.been.calledOnceWithExactly(
        'users.login.success',
        null,
        'passportTrackEvent',
        rootSpan,
        'extended'
      )
    })

    it('should not call trackEvent in extended mode if trackUserLoginFailureEvent is already called', () => {
      rootSpan.context = () => {
        return {
          _tags: {
            '_dd.appsec.events.users.login.failure.sdk': 'true'
          }
        }
      }

      passportModule.passportTrackEvent(loginLocal, userUuid, rootSpan, 'extended')
      expect(setUser.setUserTags).not.to.have.been.called
      expect(events.trackEvent).not.to.have.been.called
    })

    it('should report login success with the _id field', () => {
      const user = {
        _id: '591dc126-8431-4d0f-9509-b23318d3dce4',
        email: 'testUser@test.com',
        username: 'Test User'
      }

      passportModule.passportTrackEvent(loginLocal, user, rootSpan, 'extended')
      expect(setUser.setUserTags).to.have.been.calledOnceWithExactly(
        {
          id: '591dc126-8431-4d0f-9509-b23318d3dce4',
          login: 'test',
          email: 'testUser@test.com',
          username: 'Test User'
        },
        rootSpan
      )
      expect(events.trackEvent).to.have.been.calledOnceWithExactly(
        'users.login.success',
        null,
        'passportTrackEvent',
        rootSpan,
        'extended'
      )
    })

    it('should report login success with the username field passport name', () => {
      const user = {
        email: 'testUser@test.com',
        name: 'Test User'
      }

      rootSpan.context = () => { return {} }

      passportModule.passportTrackEvent(loginLocal, user, rootSpan, 'extended')
      expect(setUser.setUserTags).to.have.been.calledOnceWithExactly(
        {
          id: 'test',
          login: 'test',
          email: 'testUser@test.com',
          username: 'Test User'
        }, rootSpan)
      expect(events.trackEvent).to.have.been.calledOnceWithExactly(
        'users.login.success',
        null,
        'passportTrackEvent',
        rootSpan,
        'extended'
      )
    })
  })
})
