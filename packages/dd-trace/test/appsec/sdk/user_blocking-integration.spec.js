'use strict'

const agent = require('../../plugins/agent')
const tracer = require('../../../../../index')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')
const axios = require('axios')
const path = require('path')
const blocking = require('../../../src/appsec/blocking')

describe('user_blocking - Integration with the tracer', () => {
  const config = new Config({
    appsec: {
      enabled: true,
      rules: path.join(__dirname, './user_blocking_rules.json')
    }
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
        expect(ret).to.be.false
        res.end()
      }
      agent.assertSomeTraces(traces => {
        expect(traces[0][0].meta).to.have.property('usr.id', 'testUser3')
        expect(traces[0][0].meta).to.have.property('_dd.appsec.user.collection_mode', 'sdk')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should not set the user if user is already defined', (done) => {
      controller = (req, res) => {
        tracer.setUser({ id: 'testUser' })

        const ret = tracer.appsec.isUserBlocked({ id: 'testUser3' })
        expect(ret).to.be.false
        res.end()
      }
      agent.assertSomeTraces(traces => {
        expect(traces[0][0].meta).to.have.property('usr.id', 'testUser')
        expect(traces[0][0].meta).to.have.property('_dd.appsec.user.collection_mode', 'sdk')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should return true if user is in the blocklist', (done) => {
      controller = (req, res) => {
        const ret = tracer.appsec.isUserBlocked({ id: 'blockedUser' })
        expect(ret).to.be.true
        res.end()
      }
      agent.assertSomeTraces(traces => {
        expect(traces[0][0].meta).to.have.property('usr.id', 'blockedUser')
        expect(traces[0][0].meta).to.have.property('_dd.appsec.user.collection_mode', 'sdk')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should return true action if userID was matched before with trackUserLoginSuccessEvent()', (done) => {
      controller = (req, res) => {
        tracer.appsec.trackUserLoginSuccessEvent({ id: 'blockedUser' })
        const ret = tracer.appsec.isUserBlocked({ id: 'blockedUser' })
        expect(ret).to.be.true
        res.end()
      }
      agent.assertSomeTraces(traces => {
        expect(traces[0][0].meta).to.have.property('usr.id', 'blockedUser')
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
        expect(ret).to.be.true
      }
      agent.assertSomeTraces(traces => {
        expect(traces[0][0].meta).to.have.property('appsec.blocked', 'true')
        expect(traces[0][0].meta).to.have.property('http.status_code', '403')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should set the proper tags even when not passed req and res', (done) => {
      controller = (req, res) => {
        const ret = tracer.appsec.blockRequest()
        expect(ret).to.be.true
      }
      agent.assertSomeTraces(traces => {
        expect(traces[0][0].meta).to.have.property('appsec.blocked', 'true')
        expect(traces[0][0].meta).to.have.property('http.status_code', '403')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should not set the proper tags when response has already been sent', (done) => {
      controller = (req, res) => {
        res.end()
        const ret = tracer.appsec.blockRequest()
        expect(ret).to.be.false
      }
      agent.assertSomeTraces(traces => {
        expect(traces[0][0].meta).to.not.have.property('appsec.blocked', 'true')
        expect(traces[0][0].meta).to.have.property('http.status_code', '200')
        expect(traces[0][0].metrics).to.have.property('_dd.appsec.block.failed', 1)
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`)
    })

    it('should block using redirect data if it is configured', (done) => {
      blocking.setDefaultBlockingActionParameters([
        {
          id: 'notblock',
          parameters: {
            location: '/notfound',
            status_code: 404
          }
        },
        {
          id: 'block',
          parameters: {
            location: '/redirected',
            status_code: 302
          }
        }
      ])
      controller = (req, res) => {
        const ret = tracer.appsec.blockRequest(req, res)
        expect(ret).to.be.true
      }
      agent.assertSomeTraces(traces => {
        expect(traces[0][0].meta).to.have.property('appsec.blocked', 'true')
        expect(traces[0][0].meta).to.have.property('http.status_code', '302')
      }).then(done).catch(done)
      axios.get(`http://localhost:${port}/`, { maxRedirects: 0 })
    })
  })
})
