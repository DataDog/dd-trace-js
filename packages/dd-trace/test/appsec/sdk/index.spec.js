const proxyquire = require('proxyquire')
const agent = require('../../plugins/agent')
const getPort = require('get-port')
const axios = require('axios')
const appsec = require('../../../src/appsec')
const tracer = require('../../../../../index')
const Config = require('../../../src/config')
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

    it('trackUserLoginSuccessEvent should cal to track_event trackUserLoginSuccessEvent', () => {
      const user = { id: 'user_id' }
      const metadata = { key: 'value' }
      appsecSdk.trackUserLoginSuccessEvent(user, metadata)
      expect(trackUserLoginSuccessEvent).to.be.calledOnceWith(tracer, user, metadata)
    })

    it('trackUserLoginFailureEvent should cal to track_event trackUserLoginFailureEvent', () => {
      const user = { id: 'user_id' }
      const metadata = { key: 'value' }
      appsecSdk.trackUserLoginFailureEvent(user, metadata)
      expect(trackUserLoginFailureEvent).to.be.calledOnceWith(tracer, user, metadata)
    })

    it('trackCustomEvent should cal to track_event trackCustomEvent', () => {
      const metadata = { key: 'value' }
      appsecSdk.trackCustomEvent('event_name', metadata)
      expect(trackCustomEvent).to.be.calledOnceWith(tracer, 'event_name', metadata)
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
    })

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

    beforeEach(() => {
      appsec.enable(new Config({
        appsec: {
          enabled: true
        }
      }))
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
          // TODO check - why manual.keep sometimes come in metris and others in meta?
          expect(traces[0][0].metrics['manual.keep'] === 1 || traces[0][0].meta['manual.keep'] === 'true').to.be.true
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not track without user', (done) => {
        controller = (req, res) => {
          tracer.appsec.trackUserLoginSuccessEvent(undefined, { metakey: 'metaValue' })
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).not.to.have.property('appsec.events.users.login.success.track', 'true')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not track without call to the sdk method', (done) => {
        controller = (req, res) => {
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).not.to.have.property('appsec.events.users.login.success.track', 'true')
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
          expect(traces[0][0].metrics['manual.keep'] === 1 || traces[0][0].meta['manual.keep'] === 'true').to.be.true
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
          expect(traces[0][0].metrics['manual.keep'] === 1 || traces[0][0].meta['manual.keep'] === 'true').to.be.true
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not track without user', (done) => {
        controller = (req, res) => {
          tracer.appsec.trackUserLoginFailureEvent(undefined, false, { metakey: 'metaValue' })
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).not.to.have.property('appsec.events.users.login.failure.track', 'true')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not track without call to the sdk method', (done) => {
        controller = (req, res) => {
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).not.to.have.property('appsec.events.users.login.failure.track', 'true')
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
          expect(traces[0][0].metrics['manual.keep'] === 1 || traces[0][0].meta['manual.keep'] === 'true').to.be.true
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not track not valid event name', (done) => {
        controller = (req, res) => {
          tracer.appsec.trackCustomEvent(null, { metakey: 'metaValue' })
          tracer.appsec.trackCustomEvent({ event: 'name' }, { metakey: 'metaValue' })
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].metrics).not.to.have.property('manual.keep', 1)
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })
    })
  })
})
