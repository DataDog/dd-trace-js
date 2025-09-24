'use strict'

const axios = require('axios')
const { expect } = require('chai')
const { describe, it } = require('mocha')

const agent = require('../../plugins/agent')
const tracer = require('../../../../../index')
const { USER_KEEP } = require('../../../../../ext/priority')

describe('track_event - Integration with the tracer', () => {
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
      agent.assertSomeTraces(traces => {
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
      agent.assertSomeTraces(traces => {
        expect(traces[0][0].meta).to.not.have.property('appsec.events.users.login.success.track', 'true')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should not track without calling the sdk method', (done) => {
      controller = (req, res) => {
        res.end()
      }
      agent.assertSomeTraces(traces => {
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
      agent.assertSomeTraces(traces => {
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
      agent.assertSomeTraces(traces => {
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
      agent.assertSomeTraces(traces => {
        expect(traces[0][0].meta).to.not.have.property('appsec.events.users.login.failure.track', 'true')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should not track without calling the sdk method', (done) => {
      controller = (req, res) => {
        res.end()
      }
      agent.assertSomeTraces(traces => {
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
      agent.assertSomeTraces(traces => {
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
      agent.assertSomeTraces(traces => {
        expect(traces[0][0].metrics).to.not.have.property('_sampling_priority_v1', USER_KEEP)
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })
  })
})
