'use strict'

const assert = require('node:assert')
const dc = require('dc-polyfill')
const { describe, it, before, after, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')

describe('light-my-request instrumentation', () => {
  const startServerCh = dc.channel('apm:http:server:request:start')
  const exitServerCh = dc.channel('apm:http:server:request:exit')
  const finishServerCh = dc.channel('apm:http:server:request:finish')
  const errorServerCh = dc.channel('apm:http:server:request:error')

  let startStub, exitStub, finishStub, errorStub
  let inject, Fastify

  before(async () => {
    await agent.load(['http', 'fastify', 'light-my-request'], { client: false })
    inject = require('light-my-request')
    Fastify = require('fastify')
  })

  after(() => {
    return agent.close({ ritmReset: false })
  })

  beforeEach(() => {
    startStub = sinon.stub()
    exitStub = sinon.stub()
    finishStub = sinon.stub()
    errorStub = sinon.stub()

    startServerCh.subscribe(startStub)
    exitServerCh.subscribe(exitStub)
    finishServerCh.subscribe(finishStub)
    errorServerCh.subscribe(errorStub)
  })

  afterEach(() => {
    startServerCh.unsubscribe(startStub)
    exitServerCh.unsubscribe(exitStub)
    finishServerCh.unsubscribe(finishStub)
    errorServerCh.unsubscribe(errorStub)
  })

  describe('with Fastify inject()', () => {
    let app

    beforeEach(async () => {
      app = Fastify()
      app.get('/test', async (req, reply) => {
        return { success: true }
      })
      app.get('/error', async (req, reply) => {
        throw new Error('Test error')
      })
      await app.ready()
    })

    afterEach(async () => {
      await app.close()
    })

    it('should publish to start channel on inject', async () => {
      await app.inject({
        method: 'GET',
        url: '/test'
      })

      sinon.assert.called(startStub)

      // Find the call for our /test request (filter out any dd-trace internal requests)
      const testCall = startStub.getCalls().find(call => {
        const { req } = call.args[0]
        return req.url === '/test'
      })

      assert(testCall, 'start channel should be called for /test request')
      const { req, res, abortController } = testCall.args[0]
      assert.strictEqual(req.url, '/test')
      assert.strictEqual(req.method, 'GET')
      assert(res, 'res should be provided')
      assert(abortController instanceof AbortController, 'abortController should be provided')
    })

    it('should publish to exit channel after inject dispatch', async () => {
      await app.inject({
        method: 'GET',
        url: '/test'
      })

      sinon.assert.called(exitStub)

      const testCall = exitStub.getCalls().find(call => {
        const { req } = call.args[0]
        return req.url === '/test'
      })

      assert(testCall, 'exit channel should be called for /test request')
    })

    it('should publish to finish channel when response completes', async () => {
      await app.inject({
        method: 'GET',
        url: '/test'
      })

      // Wait a tick for finish event to propagate
      await new Promise(resolve => setImmediate(resolve))

      sinon.assert.called(finishStub)

      const testCall = finishStub.getCalls().find(call => {
        const { req } = call.args[0]
        return req.url === '/test'
      })

      assert(testCall, 'finish channel should be called for /test request')
    })

    it('should link res.req for context tracking', async () => {
      let capturedRes

      const handler = ({ req, res }) => {
        if (req.url === '/test') {
          capturedRes = res
        }
      }
      startServerCh.subscribe(handler)

      try {
        await app.inject({
          method: 'GET',
          url: '/test'
        })

        assert(capturedRes, 'response should be captured')
        assert(capturedRes.req, 'res.req should be set')
        assert.strictEqual(capturedRes.req.url, '/test')
      } finally {
        startServerCh.unsubscribe(handler)
      }
    })

    it('should provide abortController to subscribers', async () => {
      let capturedAbortController

      const handler = ({ req, abortController }) => {
        if (req.url === '/test') {
          capturedAbortController = abortController
        }
      }
      startServerCh.subscribe(handler)

      try {
        await app.inject({
          method: 'GET',
          url: '/test'
        })

        assert(capturedAbortController, 'abortController should be captured')
        assert(capturedAbortController instanceof AbortController, 'should be an AbortController')
        assert.strictEqual(typeof capturedAbortController.abort, 'function', 'should have abort method')
      } finally {
        startServerCh.unsubscribe(handler)
      }
    })

    it('should pass request headers correctly', async () => {
      let capturedHeaders

      const handler = ({ req }) => {
        if (req.url === '/test') {
          capturedHeaders = req.headers
        }
      }
      startServerCh.subscribe(handler)

      try {
        await app.inject({
          method: 'GET',
          url: '/test',
          headers: {
            'x-custom-header': 'test-value',
            'x-trace-id': '12345'
          }
        })

        assert(capturedHeaders, 'headers should be captured')
        assert.strictEqual(capturedHeaders['x-custom-header'], 'test-value')
        assert.strictEqual(capturedHeaders['x-trace-id'], '12345')
      } finally {
        startServerCh.unsubscribe(handler)
      }
    })

    it('should work with different HTTP methods', async () => {
      const methods = []

      // Create a new app with all routes registered before ready()
      const multiMethodApp = Fastify()
      multiMethodApp.get('/multi', async () => ({ method: 'GET' }))
      multiMethodApp.post('/multi', async () => ({ method: 'POST' }))
      multiMethodApp.put('/multi', async () => ({ method: 'PUT' }))
      multiMethodApp.delete('/multi', async () => ({ method: 'DELETE' }))
      await multiMethodApp.ready()

      const handler = ({ req }) => {
        if (req.url === '/multi') {
          methods.push(req.method)
        }
      }
      startServerCh.subscribe(handler)

      try {
        await multiMethodApp.inject({ method: 'GET', url: '/multi' })
        await multiMethodApp.inject({ method: 'POST', url: '/multi' })
        await multiMethodApp.inject({ method: 'PUT', url: '/multi' })
        await multiMethodApp.inject({ method: 'DELETE', url: '/multi' })

        assert.deepStrictEqual(methods, ['GET', 'POST', 'PUT', 'DELETE'])
      } finally {
        startServerCh.unsubscribe(handler)
        await multiMethodApp.close()
      }
    })
  })

  describe('with standalone light-my-request', () => {
    it('should instrument direct inject() calls', async () => {
      const dispatchFunc = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }

      await inject(dispatchFunc, {
        method: 'GET',
        url: '/standalone-test'
      })

      sinon.assert.called(startStub)

      const testCall = startStub.getCalls().find(call => {
        const { req } = call.args[0]
        return req.url === '/standalone-test'
      })

      assert(testCall, 'start channel should be called for standalone inject')
    })

    it('should work with callback style', (done) => {
      const dispatchFunc = (req, res) => {
        res.writeHead(200)
        res.end('OK')
      }

      inject(dispatchFunc, { method: 'GET', url: '/callback-test' }, (err, response) => {
        if (err) return done(err)

        try {
          sinon.assert.called(startStub)

          const testCall = startStub.getCalls().find(call => {
            const { req } = call.args[0]
            return req.url === '/callback-test'
          })

          assert(testCall, 'start channel should be called for callback-style inject')
          done()
        } catch (e) {
          done(e)
        }
      })
    })
  })
})
