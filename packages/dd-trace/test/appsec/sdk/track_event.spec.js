'use strict'

const proxyquire = require('proxyquire')
const agent = require('../../plugins/agent')
const getPort = require('get-port')
const axios = require('axios')
const tracer = require('../../../../../index')

describe('track_event', () => {
  describe('Internal API', () => {
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
        expect(log.warn.secondCall)
          .to.have.been.calledWithExactly('Invalid user provided to trackUserLoginSuccessEvent')
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
        expect(log.warn.firstCall)
          .to.have.been.calledWithExactly('Invalid userId provided to trackUserLoginFailureEvent')
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
      port = await getPort()
      await agent.load('http')
      http = require('http')
    })

    before(done => {
      const server = new http.Server(listener)
      appListener = server
        .listen(port, 'localhost', () => done())
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
          expect(traces[0][0].meta).to.have.property('manual.keep', 'true')
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
          expect(traces[0][0].meta).to.have.property('manual.keep', 'true')
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
          expect(traces[0][0].meta).to.have.property('manual.keep', 'true')
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
          expect(traces[0][0].meta).to.have.property('manual.keep', 'true')
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
          expect(traces[0][0].meta).to.not.have.property('manual.keep', 'true')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })
    })
  })
})
