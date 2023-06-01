'use strict'

const proxyquire = require('proxyquire')

describe('Passport', () => {
  const rootSpan = {
    context: () => {}
  }
  const loginLocal = { type: 'local', username: 'test' }
  const userUuid = {
    id: '591dc126-8431-4d0f-9509-b23318d3dce4',
    email: 'testUser@test.com',
    username: 'Test User'
  }

  let passportModule, log, events, setUser
  beforeEach(() => {
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
      passportModule.passportTrackEvent(undefined, undefined, undefined, undefined, undefined, 'safe')

      expect(log.warn).to.have.been.calledOnceWithExactly('No username found in authentication instrumentation')
    })

    it('should call log when type is not known', () => {
      const credentials = { type: 'unknown', username: 'test' }

      passportModule.passportTrackEvent(credentials, undefined, undefined, undefined, undefined, 'safe')

      expect(log.warn).to.have.been.calledOnceWithExactly('No username found in authentication instrumentation')
    })

    it('should call log when type is known but username not present', () => {
      const credentials = { type: 'unknown' }

      passportModule.passportTrackEvent(credentials, undefined, undefined, undefined, undefined, 'safe')

      expect(log.warn).to.have.been.calledOnceWithExactly('No username found in authentication instrumentation')
    })

    it('should report login failure when passportUser is not present', () => {
      passportModule.passportTrackEvent(loginLocal, undefined, undefined, undefined, undefined, 'safe')

      expect(setUser.setUserTags).not.to.have.been.called
      expect(events.trackEvent).to.have.been.calledOnceWithExactly(
        'users.login.failure',
        { 'usr.id': loginLocal.username },
        'passportTrackEvent',
        undefined,
        'safe'
      )
    })

    it('should report login success when passportUser is present', () => {
      passportModule.passportTrackEvent(loginLocal, userUuid, undefined, undefined, rootSpan, 'safe')

      expect(setUser.setUserTags).to.have.been.calledOnceWithExactly(userUuid.id, rootSpan)
      expect(events.trackEvent).to.have.been.calledOnceWithExactly(
        'users.login.success',
        { 'usr.id': userUuid.id },
        'passportTrackEvent',
        rootSpan,
        'safe'
      )
    })

    it('should report login success and blank id in safe mode when id is not a uuid', () => {
      const user = userUuid

      user.id = 'publicName'
      passportModule.passportTrackEvent(loginLocal, user, undefined, undefined, rootSpan, 'safe')

      expect(setUser.setUserTags).to.have.been.calledOnceWithExactly('', rootSpan)
      expect(events.trackEvent).to.have.been.calledOnceWithExactly(
        'users.login.success',
        { 'usr.id': '' },
        'passportTrackEvent',
        rootSpan,
        'safe'
      )
    })

    it('should report login success and the extended fields in extended mode', () => {
      const user = userUuid

      user.id = 'publicName'
      passportModule.passportTrackEvent(loginLocal, user, undefined, undefined, rootSpan, 'extended')
      expect(setUser.setUserTags).to.have.been.calledOnceWithExactly(user.id, rootSpan)
      expect(events.trackEvent).to.have.been.calledOnceWithExactly(
        'users.login.success',
        {
          'usr.id': user.id,
          'usr.email': user.email,
          'usr.username': user.username,
          'usr.login': loginLocal.username
        },
        'passportTrackEvent',
        rootSpan,
        'extended'
      )
    })

    it('should not call trackEvent in safe mode if sdk track event functions are already called', () => {
      rootSpan.context = () => {
        return {
          _tags: {
            '_dd.appsec.events.users.login.success.sdk': 'true'
          }
        }
      }

      passportModule.passportTrackEvent(loginLocal, userUuid, undefined, undefined, rootSpan, 'safe')
      expect(setUser.setUserTags).not.to.have.been.called
      expect(events.trackEvent).not.to.have.been.called
    })

    it('should not call trackEvent in extended mode if sdk track event functions are already called', () => {
      rootSpan.context = () => {
        return {
          _tags: {
            '_dd.appsec.events.users.login.success.sdk': 'true'
          }
        }
      }

      passportModule.passportTrackEvent(loginLocal, userUuid, undefined, undefined, rootSpan, 'extended')
      expect(setUser.setUserTags).not.to.have.been.called
      expect(events.trackEvent).not.to.have.been.called
    })
  })
})
