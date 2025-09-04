'use strict'

const { assert } = require('chai')
const dc = require('dc-polyfill')
const axios = require('axios')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

withVersions('express-session', 'express-session', version => {
  describe('express-session instrumentation', () => {
    const sessionMiddlewareCh = dc.channel('datadog:express-session:middleware:finish')
    let port, server, subscriberStub, routeHandlerStub

    before(() => {
      return agent.load(['http'], { client: false })
    })

    before((done) => {
      const express = require('../../../versions/express').get()
      const expressSession = require(`../../../versions/express-session@${version}`).get()

      const app = express()

      app.use(expressSession({
        secret: 'secret',
        resave: false,
        rolling: true,
        saveUninitialized: true,
        genid: () => 'sid_123'
      }))

      app.get('/', (req, res) => {
        routeHandlerStub()

        res.send('OK')
      })

      server = app.listen(0, () => {
        port = server.address().port
        done()
      })
    })

    beforeEach(() => {
      routeHandlerStub = sinon.stub()
      subscriberStub = sinon.stub()

      sessionMiddlewareCh.subscribe(subscriberStub)
    })

    afterEach(() => {
      sessionMiddlewareCh.unsubscribe(subscriberStub)
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not do anything when there are no subscribers', async () => {
      sessionMiddlewareCh.unsubscribe(subscriberStub)

      const res = await axios.get(`http://localhost:${port}/`)

      assert.equal(res.data, 'OK')
      sinon.assert.notCalled(subscriberStub)
      sinon.assert.calledOnce(routeHandlerStub)
    })

    it('should call the subscriber when the middleware is called', async () => {
      subscriberStub.callsFake(({ sessionId }) => {
        assert.equal(sessionId, 'sid_123')
      })

      const res = await axios.get(`http://localhost:${port}/`)

      assert.equal(res.data, 'OK')
      sinon.assert.calledOnce(subscriberStub)
      sinon.assert.calledOnce(routeHandlerStub)
    })

    it('should not call next when the subscriber calls abort()', async () => {
      subscriberStub.callsFake(({ res, abortController }) => {
        res.end('BLOCKED')
        abortController.abort()
      })

      const res = await axios.get(`http://localhost:${port}/`)

      assert.equal(res.data, 'BLOCKED')
      sinon.assert.calledOnce(subscriberStub)
      sinon.assert.notCalled(routeHandlerStub)
    })
  })
})
