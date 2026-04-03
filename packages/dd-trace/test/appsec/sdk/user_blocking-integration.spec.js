'use strict'

const assert = require('node:assert/strict')
const path = require('path')

const axios = require('axios')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const tracer = require('../../../../../index')
const appsec = require('../../../src/appsec')
const blocking = require('../../../src/appsec/blocking')
const { getConfigFresh } = require('../../helpers/config')
const agent = require('../../plugins/agent')

describe('user_blocking - Integration with the tracer', () => {
  const config = getConfigFresh({
    appsec: {
      enabled: true,
      rules: path.join(__dirname, './user_blocking_rules.json'),
    },
  })

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

    appsec.enable(config)
  })

  after(() => {
    appsec.disable()

    appListener.close()
    return agent.close({ ritmReset: false })
  })

  describe('isUserBlocked', () => {
    it('should set the user if user is not defined', (done) => {
      controller = (req, res) => {
        const ret = tracer.appsec.isUserBlocked({ id: 'testUser3' })
        assert.strictEqual(ret, false)
        res.end()
      }
      agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0][0].meta['usr.id'], 'testUser3')
        assert.strictEqual(traces[0][0].meta['_dd.appsec.user.collection_mode'], 'sdk')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should not set the user if user is already defined', (done) => {
      controller = (req, res) => {
        tracer.setUser({ id: 'testUser' })

        const ret = tracer.appsec.isUserBlocked({ id: 'testUser3' })
        assert.strictEqual(ret, false)
        res.end()
      }
      agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0][0].meta['usr.id'], 'testUser')
        assert.strictEqual(traces[0][0].meta['_dd.appsec.user.collection_mode'], 'sdk')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should return true if user is in the blocklist', (done) => {
      controller = (req, res) => {
        const ret = tracer.appsec.isUserBlocked({ id: 'blockedUser' })
        assert.strictEqual(ret, true)
        res.end()
      }
      agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0][0].meta['usr.id'], 'blockedUser')
        assert.strictEqual(traces[0][0].meta['_dd.appsec.user.collection_mode'], 'sdk')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should return true action if userID was matched before with trackUserLoginSuccessEvent()', (done) => {
      controller = (req, res) => {
        tracer.appsec.trackUserLoginSuccessEvent({ id: 'blockedUser' })
        const ret = tracer.appsec.isUserBlocked({ id: 'blockedUser' })
        assert.strictEqual(ret, true)
        res.end()
      }
      agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0][0].meta['usr.id'], 'blockedUser')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })
  })

  describe('blockRequest', () => {
    beforeEach(() => {
      // reset to default, other tests may have changed it with RC
      blocking.setDefaultBlockingActionParameters(undefined)
    })

    afterEach(() => {
      // reset to default
      blocking.setDefaultBlockingActionParameters(undefined)
    })

    it('should set the proper tags', (done) => {
      controller = (req, res) => {
        const ret = tracer.appsec.blockRequest(req, res)
        assert.strictEqual(ret, true)
      }
      agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0][0].meta['appsec.blocked'], 'true')
        assert.strictEqual(traces[0][0].meta['http.status_code'], '403')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should set the proper tags even when not passed req and res', (done) => {
      controller = (req, res) => {
        const ret = tracer.appsec.blockRequest()
        assert.strictEqual(ret, true)
      }
      agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0][0].meta['appsec.blocked'], 'true')
        assert.strictEqual(traces[0][0].meta['http.status_code'], '403')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should not set the proper tags when response has already been sent', (done) => {
      controller = (req, res) => {
        res.end()
        const ret = tracer.appsec.blockRequest()
        assert.strictEqual(ret, false)
      }
      agent.assertSomeTraces(traces => {
        assert.ok(!('appsec.blocked' in traces[0][0].meta) || traces[0][0].meta['appsec.blocked'] !== 'true')
        assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
        assert.strictEqual(traces[0][0].metrics['_dd.appsec.block.failed'], 1)
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should block using redirect data if it is configured', (done) => {
      blocking.setDefaultBlockingActionParameters([
        {
          id: 'notblock',
          parameters: {
            location: '/notfound',
            status_code: 404,
          },
        },
        {
          id: 'block',
          parameters: {
            location: '/redirected',
            status_code: 302,
          },
        },
      ])
      controller = (req, res) => {
        const ret = tracer.appsec.blockRequest(req, res)
        assert.strictEqual(ret, true)
      }
      agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0][0].meta['appsec.blocked'], 'true')
        assert.strictEqual(traces[0][0].meta['http.status_code'], '302')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`, { maxRedirects: 0 })
    })
  })
})
