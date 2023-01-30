'use strict'

const proxyquire = require('proxyquire')
const agent = require('../../plugins/agent')
const getPort = require('get-port')
const axios = require('axios')
const tracer = require('../../../../../index')

describe('Appsec SDK', () => {
  describe('calls to external methods', () => {
    let trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent
    let appsecSdk
    const tracer = {}

    beforeEach(() => {
      trackUserLoginSuccessEvent = sinon.stub()
      trackUserLoginFailureEvent = sinon.stub()
      trackCustomEvent = sinon.stub()

      const AppsecSdk = proxyquire('../../../src/appsec/sdk', {
        './track_event': { trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent }
      })

      appsecSdk = new AppsecSdk(tracer)
    })

    it('trackUserLoginSuccessEvent should call track_event trackUserLoginSuccessEvent', () => {
      const user = { id: 'user_id' }
      const metadata = { key: 'value' }
      appsecSdk.trackUserLoginSuccessEvent(user, metadata)

      expect(trackUserLoginSuccessEvent).to.have.been.calledOnceWithExactly(tracer, user, metadata)
    })

    it('trackUserLoginFailureEvent should call track_event trackUserLoginFailureEvent', () => {
      const userId = 'user_id'
      const exists = false
      const metadata = { key: 'value' }
      appsecSdk.trackUserLoginFailureEvent(userId, exists, metadata)

      expect(trackUserLoginFailureEvent).to.have.been.calledOnceWithExactly(tracer, userId, exists, metadata)
    })

    it('trackCustomEvent should call track_event trackCustomEvent', () => {
      const metadata = { key: 'value' }
      appsecSdk.trackCustomEvent('event_name', metadata)

      expect(trackCustomEvent).to.have.been.calledOnceWithExactly(tracer, 'event_name', metadata)
    })
  })

  describe('in request', () => {
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
