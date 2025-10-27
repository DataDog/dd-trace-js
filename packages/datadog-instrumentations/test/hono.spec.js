'use strict'

const axios = require('axios')
const { expect } = require('chai')
const dc = require('dc-polyfill')
const { describe, it, beforeEach, before, after } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

withVersions('hono', 'hono', version => {
  describe('hono instrumentation', () => {
    let routeChannelCb, handleChannelCb, errorChannelCb, nextChannelCb
    let enterChannelCb, exitChannelCb, finishChannelCb
    let port, server, middlewareCalled

    const routeChannel = dc.channel('apm:hono:request:route')
    const handleChannel = dc.channel('apm:hono:request:handle')
    const errorChannel = dc.channel('apm:hono:request:error')
    const nextChannel = dc.channel('apm:hono:middleware:next')
    const enterChannel = dc.channel('apm:hono:middleware:enter')
    const exitChannel = dc.channel('apm:hono:middleware:exit')
    const finishChannel = dc.channel('apm:hono:middleware:finish')

    before(() => {
      return agent.load('hono', { client: false })
    })

    before((done) => {
      const { Hono } = require(`../../../versions/hono@${version}`).get()
      const { serve } = require('../../../versions/@hono/node-server').get()
      const app = new Hono()

      // Add a middleware
      app.use(async (_c, next) => {
        middlewareCalled()
        await next()
      })

      // Add a route
      app.get('/test', (c) => {
        return c.text('OK')
      })

      // Add an error route
      app.get('/error', (_c) => {
        throw new Error('test error')
      })

      server = serve({ port: 0, fetch: app.fetch }, (info) => {
        port = info.port
        done()
      })
    })

    beforeEach(() => {
      routeChannelCb = sinon.stub()
      handleChannelCb = sinon.stub()
      errorChannelCb = sinon.stub()
      nextChannelCb = sinon.stub()
      enterChannelCb = sinon.stub()
      exitChannelCb = sinon.stub()
      finishChannelCb = sinon.stub()
      middlewareCalled = sinon.stub()

      routeChannel.subscribe(routeChannelCb)
      handleChannel.subscribe(handleChannelCb)
      errorChannel.subscribe(errorChannelCb)
      nextChannel.subscribe(nextChannelCb)
      enterChannel.subscribe(enterChannelCb)
      exitChannel.subscribe(exitChannelCb)
      finishChannel.subscribe(finishChannelCb)
    })

    afterEach(() => {
      routeChannel.unsubscribe(routeChannelCb)
      handleChannel.unsubscribe(handleChannelCb)
      errorChannel.unsubscribe(errorChannelCb)
      nextChannel.unsubscribe(nextChannelCb)
      enterChannel.unsubscribe(enterChannelCb)
      exitChannel.unsubscribe(exitChannelCb)
      finishChannel.unsubscribe(finishChannelCb)
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should publish to handleChannel on request', async () => {
      const res = await axios.get(`http://localhost:${port}/test`)

      expect(res.data).to.equal('OK')
      sinon.assert.called(handleChannelCb)
    })

    it('should publish to routeChannel when middleware is invoked', async () => {
      const res = await axios.get(`http://localhost:${port}/test`)

      expect(res.data).to.equal('OK')
      sinon.assert.called(routeChannelCb)
      expect(middlewareCalled).to.be.calledOnce
    })

    it('should publish to enterChannel when middleware starts', async () => {
      const res = await axios.get(`http://localhost:${port}/test`)

      expect(res.data).to.equal('OK')
      sinon.assert.called(enterChannelCb)
      const callArgs = enterChannelCb.firstCall.args[0]
      expect(callArgs).to.have.property('req')
      expect(callArgs).to.have.property('name')
    })

    it('should publish to exitChannel when middleware exits', async () => {
      const res = await axios.get(`http://localhost:${port}/test`)

      expect(res.data).to.equal('OK')
      sinon.assert.called(exitChannelCb)
      const callArgs = exitChannelCb.firstCall.args[0]
      expect(callArgs).to.have.property('req')
    })

    it('should publish to finishChannel when middleware completes', async () => {
      const res = await axios.get(`http://localhost:${port}/test`)

      expect(res.data).to.equal('OK')
      sinon.assert.called(finishChannelCb)
      const callArgs = finishChannelCb.firstCall.args[0]
      expect(callArgs).to.have.property('req')
    })

    it('should publish to nextChannel when next() is called', async () => {
      const res = await axios.get(`http://localhost:${port}/test`)

      expect(res.data).to.equal('OK')
      sinon.assert.called(nextChannelCb)
      const callArgs = nextChannelCb.firstCall.args[0]
      expect(callArgs).to.have.property('req')
    })

    it('should publish to errorChannel when middleware throws', async () => {
      try {
        await axios.get(`http://localhost:${port}/error`)
      } catch (e) {
        // Expected to fail
      }

      sinon.assert.called(errorChannelCb)
      const callArgs = errorChannelCb.firstCall.args[0]
      expect(callArgs).to.have.property('req')
      expect(callArgs).to.have.property('error')
      expect(callArgs.error.message).to.equal('test error')
    })
  })
})
