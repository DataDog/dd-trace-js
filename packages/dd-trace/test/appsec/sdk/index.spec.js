'use strict'

const proxyquire = require('proxyquire')
const agent = require('../../plugins/agent')
const getPort = require('get-port')
const axios = require('axios')
const tracer = require('../../../../../index')

describe('Appsec SDK', () => {
  describe('Test public API', () => {
    const tracer = {}
    const mockReq = { protocol: 'https' }
    const mockRes = { headersSent: false }
    const loadTemplates = sinon.stub()
    let sdk, checkUserAndSetUser, blockRequest, setUser, trackUserLoginSuccessEvent, trackUserLoginFailureEvent,
      trackCustomEvent

    beforeEach(() => {
      trackUserLoginSuccessEvent = sinon.stub()
      trackUserLoginFailureEvent = sinon.stub()
      trackCustomEvent = sinon.stub()
      checkUserAndSetUser = sinon.stub()
      blockRequest = sinon.stub()
      setUser = sinon.stub()

      const AppsecSdk = proxyquire('../../../src/appsec/sdk', {
        './track_event': { trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent },
        './user_blocking': { checkUserAndSetUser, blockRequest },
        './set_user': { setUser },
        '../blocking': { loadTemplates }
      })

      sdk = new AppsecSdk(tracer)
    })

    it('isUserBlocked should call internal function with proper params', () => {
      const user = { id: 'user' }
      sdk.isUserBlocked(user)
      expect(checkUserAndSetUser).to.be.calledOnceWithExactly(tracer, user)
    })

    it('blockRequest should call internal function wit proper params', () => {
      sdk.blockRequest(mockReq, mockRes)
      expect(blockRequest).to.be.calledOnceWithExactly(tracer, mockReq, mockRes)
    })

    it('setUser should call internal function with proper params', () => {
      const user = { id: 'user' }
      sdk.setUser(user)
      expect(setUser).to.be.calledOnceWithExactly(tracer, user)
    })

    it('trackUserLoginSuccessEvent should call internal function with proper params', () => {
      const user = { id: 'user' }
      const metadata = {}
      sdk.trackUserLoginSuccessEvent(user, metadata)
      expect(trackUserLoginSuccessEvent).to.be.calledWith(tracer, user, metadata)
    })

    it('trackUserLoginFailureEvent should call internal function with proper params', () => {
      const user = { id: 'user' }
      const metadata = {}
      sdk.trackUserLoginFailureEvent(user, metadata)
      expect(trackUserLoginFailureEvent).to.be.calledWith(tracer, user, metadata)
    })

    it('trackCustomEvent should call internal function with proper params', () => {
      const eventName = 'customEvent'
      const metadata = {}
      sdk.trackUserLoginFailureEvent(eventName, metadata)
      expect(trackUserLoginFailureEvent).to.be.calledWith(tracer, eventName, metadata)
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
