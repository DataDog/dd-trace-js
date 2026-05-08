'use strict'

const assert = require('assert/strict')

const axios = require('axios')
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
      app.use(async function named (_c, next) {
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

      assert.strictEqual(res.data, 'OK')
      sinon.assert.called(handleChannelCb)
    })

    it('should publish to middleware channels', async () => {
      const res = await axios.get(`http://localhost:${port}/test`)

      sinon.assert.called(routeChannelCb)
      sinon.assert.calledOnce(middlewareCalled)

      assert.strictEqual(res.data, 'OK')
      sinon.assert.called(enterChannelCb)
      let callArgs = enterChannelCb.firstCall.args[0]
      assert.deepStrictEqual(Object.keys(callArgs), ['req', 'name', 'route'])
      assert.strictEqual(callArgs.req.url, '/test')
      assert.strictEqual(callArgs.name, 'named')

      sinon.assert.called(nextChannelCb)
      callArgs = nextChannelCb.firstCall.args[0]
      assert.deepStrictEqual(Object.keys(callArgs), ['req', 'route'])
      assert.strictEqual(callArgs.req.url, '/test')

      sinon.assert.called(exitChannelCb)
      callArgs = exitChannelCb.firstCall.args[0]
      assert.deepStrictEqual(Object.keys(callArgs), ['req', 'route'])
      assert.strictEqual(callArgs.req.url, '/test')

      sinon.assert.called(finishChannelCb)
      callArgs = finishChannelCb.firstCall.args[0]
      assert.deepStrictEqual(Object.keys(callArgs), ['req'])
      assert.strictEqual(callArgs.req.url, '/test')
    })

    it('should publish to errorChannel when middleware throws', async () => {
      try {
        await axios.get(`http://localhost:${port}/error`)
      } catch (e) {
        // Expected to fail
      }

      sinon.assert.called(errorChannelCb)
      const callArgs = errorChannelCb.firstCall.args[0]
      assert.deepStrictEqual(Object.keys(callArgs), ['req', 'error'])
      assert.strictEqual(callArgs.req.url, '/error')
      assert.strictEqual(callArgs.error.message, 'test error')
    })

    // Regression for #8198: Hono's testing helper forwards to
    // `app.fetch(request, undefined, undefined)`, so `env` and `context.env` are
    // undefined. The wrappers must not throw and must not publish events with a
    // missing IncomingMessage (the APM `web` helpers depend on one).
    describe('without a Node.js IncomingMessage', () => {
      let localApp
      let localMiddlewareCalled

      beforeEach(() => {
        const { Hono } = require(`../../../versions/hono@${version}`).get()
        localMiddlewareCalled = sinon.stub()
        localApp = new Hono()
        localApp.use(async function localNamed (_c, next) {
          localMiddlewareCalled()
          await next()
        })
        localApp.get('/test', (c) => c.text('OK'))
        localApp.get('/error', () => { throw new Error('boom') })
      })

      it('should serve `app.request()` without throwing or publishing', async () => {
        const res = await localApp.request('/test')

        assert.strictEqual(res.status, 200)
        assert.strictEqual(await res.text(), 'OK')
        sinon.assert.calledOnce(localMiddlewareCalled)
        sinon.assert.notCalled(handleChannelCb)
        sinon.assert.notCalled(routeChannelCb)
        sinon.assert.notCalled(enterChannelCb)
        sinon.assert.notCalled(nextChannelCb)
        sinon.assert.notCalled(exitChannelCb)
        sinon.assert.notCalled(finishChannelCb)
        sinon.assert.notCalled(errorChannelCb)
      })

      it('should let route errors propagate without publishing to errorChannel', async () => {
        const res = await localApp.request('/error')

        assert.strictEqual(res.status, 500)
        sinon.assert.notCalled(errorChannelCb)
        sinon.assert.notCalled(handleChannelCb)
      })
    })
  })
})
