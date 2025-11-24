'use strict'

const assert = require('node:assert/strict')

const axios = require('axios')
const { after, before, describe, it } = require('mocha')

const { USER_KEEP } = require('../../../../../ext/priority')
const tracer = require('../../../../../index')
const agent = require('../../plugins/agent')

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
        assert.strictEqual(traces[0][0].meta['appsec.events.users.login.success.track'], 'true')
        assert.strictEqual(traces[0][0].meta['usr.id'], 'test_user_id')
        assert.strictEqual(traces[0][0].meta['appsec.events.users.login.success.metakey'], 'metaValue')
        assert.strictEqual(traces[0][0].metrics._sampling_priority_v1, USER_KEEP)
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should not track without user', (done) => {
      controller = (req, res) => {
        tracer.appsec.trackUserLoginSuccessEvent(undefined, { metakey: 'metaValue' })
        res.end()
      }
      agent.assertSomeTraces(traces => {
        assert.ok(!('appsec.events.users.login.success.track' in traces[0][0].meta) || traces[0][0].meta['appsec.events.users.login.success.track'] !== 'true')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should not track without calling the sdk method', (done) => {
      controller = (req, res) => {
        res.end()
      }
      agent.assertSomeTraces(traces => {
        assert.ok(!('appsec.events.users.login.success.track' in traces[0][0].meta) || traces[0][0].meta['appsec.events.users.login.success.track'] !== 'true')
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
        assert.strictEqual(traces[0][0].meta['appsec.events.users.login.failure.track'], 'true')
        assert.strictEqual(traces[0][0].meta['appsec.events.users.login.failure.usr.id'], 'test_user_id')
        assert.strictEqual(traces[0][0].meta['appsec.events.users.login.failure.usr.exists'], 'true')
        assert.strictEqual(traces[0][0].meta['appsec.events.users.login.failure.metakey'], 'metaValue')
        assert.strictEqual(traces[0][0].metrics._sampling_priority_v1, USER_KEEP)
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should track valid non existing user', (done) => {
      controller = (req, res) => {
        tracer.appsec.trackUserLoginFailureEvent('test_user_id', false, { metakey: 'metaValue' })
        res.end()
      }
      agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0][0].meta['appsec.events.users.login.failure.track'], 'true')
        assert.strictEqual(traces[0][0].meta['appsec.events.users.login.failure.usr.id'], 'test_user_id')
        assert.strictEqual(traces[0][0].meta['appsec.events.users.login.failure.usr.exists'], 'false')
        assert.strictEqual(traces[0][0].meta['appsec.events.users.login.failure.metakey'], 'metaValue')
        assert.strictEqual(traces[0][0].metrics._sampling_priority_v1, USER_KEEP)
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should not track without user', (done) => {
      controller = (req, res) => {
        tracer.appsec.trackUserLoginFailureEvent(undefined, false, { metakey: 'metaValue' })
        res.end()
      }
      agent.assertSomeTraces(traces => {
        assert.ok(!('appsec.events.users.login.failure.track' in traces[0][0].meta) || traces[0][0].meta['appsec.events.users.login.failure.track'] !== 'true')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should not track without calling the sdk method', (done) => {
      controller = (req, res) => {
        res.end()
      }
      agent.assertSomeTraces(traces => {
        assert.ok(!('appsec.events.users.login.failure.track' in traces[0][0].meta) || traces[0][0].meta['appsec.events.users.login.failure.track'] !== 'true')
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
        assert.strictEqual(traces[0][0].meta['appsec.events.my-custom-event.track'], 'true')
        assert.strictEqual(traces[0][0].meta['appsec.events.my-custom-event.metakey'], 'metaValue')
        assert.strictEqual(traces[0][0].metrics._sampling_priority_v1, USER_KEEP)
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
        assert.ok(!('_sampling_priority_v1' in traces[0][0].metrics) || traces[0][0].metrics._sampling_priority_v1 !== USER_KEEP)
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })
  })
})
