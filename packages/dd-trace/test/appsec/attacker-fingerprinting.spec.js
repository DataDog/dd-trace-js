'use strict'

const axios = require('axios')
const { assert } = require('chai')
const agent = require('../plugins/agent')
const tracer = require('../../../../index')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')

describe('Attacker fingerprinting', () => {
  describe('SDK', () => {
    let http
    let controller
    let appListener
    let port

    function listener (req, res) {
      if (controller) {
        controller(req, res)
      }
    }

    before(() => {
      appsec.enable(new Config({
        enabled: true
      }))
    })

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
      appsec.disable()
      return agent.close({ ritmReset: false })
    })

    it('should provide fingerprinting on successful user login track', (done) => {
      controller = (req, res) => {
        tracer.appsec.trackUserLoginSuccessEvent({
          id: 'test_user_id'
        }, { metakey: 'metaValue' })
        res.end()
      }

      agent.assertSomeTraces(traces => {
        assert.property(traces[0][0].meta, '_dd.appsec.fp.http.header')
        assert.equal(traces[0][0].meta['_dd.appsec.fp.http.header'], 'hdr-0110000010-74c2908f-3-98425651')
        assert.property(traces[0][0].meta, '_dd.appsec.fp.http.network')
        assert.equal(traces[0][0].meta['_dd.appsec.fp.http.network'], 'net-0-0000000000')
      }).then(done).catch(done)

      axios.get(`http://localhost:${port}/`, {
        headers: {
          'User-Agent': 'test-user-agent'
        }
      })
    })

    it('should provide fingerprinting on failed user login track', (done) => {
      controller = (req, res) => {
        tracer.appsec.trackUserLoginFailureEvent('test_user_id', true, { metakey: 'metaValue' })
        res.end()
      }

      agent.assertSomeTraces(traces => {
        assert.property(traces[0][0].meta, '_dd.appsec.fp.http.header')
        assert.equal(traces[0][0].meta['_dd.appsec.fp.http.header'], 'hdr-0110000010-74c2908f-3-98425651')
        assert.property(traces[0][0].meta, '_dd.appsec.fp.http.network')
        assert.equal(traces[0][0].meta['_dd.appsec.fp.http.network'], 'net-0-0000000000')
      }).then(done).catch(done)

      axios.get(`http://localhost:${port}/`, {
        headers: {
          'User-Agent': 'test-user-agent'
        }
      })
    })
  })
})
