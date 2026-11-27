'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const dc = require('dc-polyfill')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
require('../setup/core')

const originalSetTimeout = global.setTimeout

describe('endpoints telemetry', () => {
  const fastifyRouteCh = dc.channel('apm:fastify:route:added')
  const expressRouteCh = dc.channel('apm:express:route:added')
  const routerRouteCh = dc.channel('apm:router:route:added')
  const nextRouteCh = dc.channel('apm:next:route:added')
  const application = 'test'
  const host = 'host'

  describe('start', () => {
    const subscribe = sinon.stub()
    const dc = { channel () { return { subscribe } } }
    const endpoints = proxyquire('../../src/telemetry/endpoints', {
      'dc-polyfill': dc,
    })

    beforeEach(() => {
      sinon.reset()
    })

    it('should subscribe', () => {
      const config = { appsec: { DD_API_SECURITY_ENDPOINT_COLLECTION_ENABLED: true } }
      endpoints.start(config)

      sinon.assert.callCount(subscribe, 4)
    })

    it('should not subscribe', () => {
      const config = { appsec: { DD_API_SECURITY_ENDPOINT_COLLECTION_ENABLED: false } }
      endpoints.start(config)

      sinon.assert.notCalled(subscribe)
    })
  })

  describe('on events', () => {
    let endpoints
    let sendData
    let getRetryData
    let updateRetryData
    let scheduledCallbacks

    beforeEach(() => {
      sendData = sinon.stub()
      getRetryData = sinon.stub()
      updateRetryData = sinon.stub()

      endpoints = proxyquire('../../src/telemetry/endpoints', {
        './send-data': { sendData },
      })
      scheduledCallbacks = []
      global.setTimeout = function (callback) {
        scheduledCallbacks.push(callback)
        return { unref () {} }
      }

      const config = {
        appsec: {
          DD_API_SECURITY_ENDPOINT_COLLECTION_ENABLED: true,
          DD_API_SECURITY_ENDPOINT_COLLECTION_MESSAGE_LIMIT: 100,
        },
      }

      endpoints.start(config, application, host, getRetryData, updateRetryData)
    })

    afterEach(() => {
      endpoints.stop()
      sendData.reset()
      getRetryData.reset()
      updateRetryData.reset()
      global.setTimeout = originalSetTimeout
    })

    it('should not fail with invalid data', () => {
      fastifyRouteCh.publish(null)
      fastifyRouteCh.publish({})
      fastifyRouteCh.publish({ routeOptions: {} })
    })

    it('should record fastify methods array', () => {
      fastifyRouteCh.publish({ routeOptions: { method: ['GET', 'post'], path: '/api' } })
      fastifyRouteCh.publish({ routeOptions: { method: 'GET', path: '/api' } })
      fastifyRouteCh.publish({ routeOptions: { method: 'POST', path: '/api' } })
      fastifyRouteCh.publish({ routeOptions: { method: 'PUT', path: '/api' } })

      scheduledCallbacks.forEach(cb => cb())

      sinon.assert.calledOnce(sendData)
      const payload = sendData.firstCall.args[4]
      assertObjectContains(payload.endpoints, [
        {
          type: 'REST',
          method: 'GET',
          path: '/api',
          operation_name: 'fastify.request',
          resource_name: 'GET /api',
        },
        {
          type: 'REST',
          method: 'POST',
          path: '/api',
          operation_name: 'fastify.request',
          resource_name: 'POST /api',
        },
        {
          type: 'REST',
          method: 'PUT',
          path: '/api',
          operation_name: 'fastify.request',
          resource_name: 'PUT /api',
        },
      ])
    })

    it('should set is_first=true only for the first payload', () => {
      fastifyRouteCh.publish({ routeOptions: { method: 'GET', path: '/one' } })
      scheduledCallbacks.forEach(cb => cb())

      fastifyRouteCh.publish({ routeOptions: { method: 'POST', path: '/two' } })
      scheduledCallbacks.forEach(cb => cb())

      assert.strictEqual(sendData.callCount, 2)
      const firstPayload = sendData.firstCall.args[4]
      const secondPayload = sendData.secondCall.args[4]

      assert.ok('is_first' in firstPayload)
      assert.strictEqual(firstPayload.is_first, true)
      assert.strictEqual(Boolean(secondPayload.is_first), false)
    })

    it('should send large amount of endpoints in small batches', () => {
      for (let i = 0; i < 150; i++) {
        fastifyRouteCh.publish({ routeOptions: { method: 'GET', path: '/' + i } })
      }

      scheduledCallbacks.forEach(cb => cb())
      scheduledCallbacks.forEach(cb => cb())

      assert.strictEqual(sendData.callCount, 2)
      const firstPayload = sendData.firstCall.args[4]
      const secondPayload = sendData.secondCall.args[4]

      assert.strictEqual(firstPayload.endpoints.length, 100)
      assert.strictEqual(secondPayload.endpoints.length, 50)
    })

    it('should record express route and add HEAD for GET', () => {
      expressRouteCh.publish({ method: 'GET', path: '/test' })

      scheduledCallbacks.forEach(cb => cb())

      sinon.assert.calledOnce(sendData)
      const payload = sendData.firstCall.args[4]
      const resources = payload.endpoints.map(e => e.resource_name)
      assert.deepStrictEqual(resources, ['GET /test', 'HEAD /test'])
    })

    it('should use express.request as operation_name for express routes', () => {
      expressRouteCh.publish({ method: 'POST', path: '/express-test' })

      scheduledCallbacks.forEach(cb => cb())

      sinon.assert.calledOnce(sendData)
      const payload = sendData.firstCall.args[4]
      assertObjectContains(payload.endpoints, [
        {
          type: 'REST',
          method: 'POST',
          path: '/express-test',
          operation_name: 'express.request',
          resource_name: 'POST /express-test',
        },
      ])
    })

    it('should use express.request as operation_name for router routes', () => {
      routerRouteCh.publish({ method: 'DELETE', path: '/router-test' })

      scheduledCallbacks.forEach(cb => cb())

      sinon.assert.calledOnce(sendData)
      const payload = sendData.firstCall.args[4]
      assertObjectContains(payload.endpoints, [
        {
          type: 'REST',
          method: 'DELETE',
          path: '/router-test',
          operation_name: 'express.request',
          resource_name: 'DELETE /router-test',
        },
      ])
    })

    it('should record express wildcard and ignore subsequent specific methods for same path', () => {
      expressRouteCh.publish({ method: '*', path: '/all' })
      expressRouteCh.publish({ method: 'GET', path: '/all' })
      expressRouteCh.publish({ method: 'POST', path: '/all' })

      scheduledCallbacks.forEach(cb => cb())

      sinon.assert.calledOnce(sendData)
      const payload = sendData.firstCall.args[4]
      const resources = payload.endpoints.map(e => e.resource_name)
      assert.deepStrictEqual(resources, ['* /all'])
    })

    it('should handle router routes the same way as express routes', () => {
      routerRouteCh.publish({ method: 'GET', path: '/router-test' })

      scheduledCallbacks.forEach(cb => cb())

      sinon.assert.calledOnce(sendData)
      const payload = sendData.firstCall.args[4]
      const resources = payload.endpoints.map(e => e.resource_name)
      assert.deepStrictEqual(resources, ['GET /router-test', 'HEAD /router-test'])
    })

    describe('next routes', () => {
      /**
       * @param {object} route
       */
      function publishNextRoute (route) {
        nextRouteCh.publish(route)
      }

      function flushResources () {
        scheduledCallbacks.splice(0).forEach(cb => cb())
        return sendData.getCalls().map(call => call.args[4].endpoints.map(e => e.resource_name))
      }

      it('should record pages, pages API routes and app pages with next.request as operation_name', () => {
        publishNextRoute({ page: '/hello/[name]', isAppPath: false, kind: 'PAGES', pathname: '/hello/[name]' })
        // Statically optimized pages and Pages API routes can load without a route module.
        publishNextRoute({ page: '/hello', isAppPath: false })
        publishNextRoute({ page: '/api/hello/[name]', isAppPath: false })
        publishNextRoute({ page: '/api', isAppPath: false })
        publishNextRoute({ page: '/apiary', isAppPath: false })
        publishNextRoute({
          page: '/(group)/appDir/[name]/page',
          isAppPath: true,
          kind: 'APP_PAGE',
          pathname: '/appDir/[name]',
        })

        scheduledCallbacks.forEach(cb => cb())

        sinon.assert.calledOnce(sendData)
        const { endpoints } = sendData.firstCall.args[4]
        assert.deepStrictEqual(endpoints.map(e => e.resource_name), [
          'GET /hello/[name]', 'HEAD /hello/[name]',
          'GET /hello', 'HEAD /hello',
          '* /api/hello/[name]',
          '* /api',
          'GET /apiary', 'HEAD /apiary',
          'GET /appDir/[name]', 'HEAD /appDir/[name]',
        ])
        assertObjectContains(endpoints[0], {
          type: 'REST',
          method: 'GET',
          path: '/hello/[name]',
          operation_name: 'next.request',
          resource_name: 'GET /hello/[name]',
        })
      })

      it('should record the methods an app route handler exports', () => {
        publishNextRoute({
          isAppPath: true,
          kind: 'APP_ROUTE',
          pathname: '/api/items',
          userland: { GET () {}, POST () {}, dynamic: 'force-dynamic', default () {} },
        })
        const allMethods = {}
        for (const method of ['PATCH', 'DELETE', 'PUT', 'POST', 'OPTIONS', 'HEAD', 'GET']) allMethods[method] = () => {}
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/all', userland: allMethods })
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/post', userland: { POST () {} } })
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/favicon.ico', userland: { GET () {} } })

        assert.deepStrictEqual(flushResources(), [[
          'GET /api/items', 'HEAD /api/items', 'POST /api/items',
          'GET /api/all', 'HEAD /api/all', 'OPTIONS /api/all', 'POST /api/all', 'PUT /api/all', 'DELETE /api/all',
          'PATCH /api/all',
          'POST /api/post',
          'GET /favicon.ico', 'HEAD /favicon.ico',
        ]])
      })

      it('should record a placeholder for a route handler without known methods', () => {
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/lazy' })
        const userland = { GET: 'not a function' }
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/none', userland })
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/null', userland: null })

        assert.deepStrictEqual(flushResources(), [['* /api/lazy', '* /api/none', '* /api/null']])
      })

      it('should replace a pending placeholder with the exported methods', () => {
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/items' })
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/other' })
        const userland = { GET () {}, POST () {} }
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/items', userland })

        assert.deepStrictEqual(flushResources(), [
          ['* /api/other', 'GET /api/items', 'HEAD /api/items', 'POST /api/items'],
        ])
      })

      it('should send only the exported methods once the placeholder was sent', () => {
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/items' })
        flushResources()
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/items', userland: { GET () {} } })

        assert.deepStrictEqual(flushResources(), [['* /api/items'], ['GET /api/items', 'HEAD /api/items']])
        assert.strictEqual(sendData.secondCall.args[4].is_first, false)
      })

      it('should record each path once', () => {
        publishNextRoute({ page: '/once', isAppPath: false })
        publishNextRoute({ page: '/once', isAppPath: false })
        // Parallel route slots share their route path.
        publishNextRoute({ page: '/dashboard/page', isAppPath: true, kind: 'APP_PAGE', pathname: '/dashboard' })
        publishNextRoute({ page: '/dashboard/@team/page', isAppPath: true, kind: 'APP_PAGE', pathname: '/dashboard' })
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/known', userland: { POST () {} } })
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/known' })
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/known', userland: { GET () {} } })
        flushResources()

        publishNextRoute({ page: '/once', isAppPath: false })

        assert.deepStrictEqual(flushResources(), [[
          'GET /once', 'HEAD /once', 'GET /dashboard', 'HEAD /dashboard', 'POST /api/known',
        ]])
      })

      it('should skip internal pages', () => {
        for (const page of ['/_app', '/_document', '/_error', '/404', '/500']) {
          publishNextRoute({ page, isAppPath: false })
        }
        publishNextRoute({ page: '/_not-found/page', isAppPath: true, kind: 'APP_PAGE', pathname: '/_not-found' })
        publishNextRoute({ page: '/_global-error/page', isAppPath: true, kind: 'APP_PAGE', pathname: '/_global-error' })
        publishNextRoute({ page: '/4040', isAppPath: false })

        assert.deepStrictEqual(flushResources(), [['GET /4040', 'HEAD /4040']])
      })

      it('should ignore invalid routes', () => {
        publishNextRoute(null)
        publishNextRoute('/hello')
        publishNextRoute({})
        publishNextRoute({ page: 1, isAppPath: false })
        // An app entry without a route module has no route path.
        publishNextRoute({ page: '/orphan/page', isAppPath: true })
        const userland = { get GET () { throw new Error('unreadable') } }
        publishNextRoute({ isAppPath: true, kind: 'APP_ROUTE', pathname: '/api/broken', userland })

        assert.deepStrictEqual(flushResources(), [['* /api/broken']])
      })

      it('should forget the recorded routes on stop', () => {
        publishNextRoute({ page: '/again', isAppPath: false })
        flushResources()
        endpoints.stop()
        endpoints.start({
          appsec: {
            DD_API_SECURITY_ENDPOINT_COLLECTION_ENABLED: true,
            DD_API_SECURITY_ENDPOINT_COLLECTION_MESSAGE_LIMIT: 100,
          },
        }, application, host, getRetryData, updateRetryData)

        publishNextRoute({ page: '/again', isAppPath: false })

        assert.deepStrictEqual(flushResources(), [['GET /again', 'HEAD /again'], ['GET /again', 'HEAD /again']])
      })

      it('should stop recording next routes after stop', () => {
        endpoints.stop()
        publishNextRoute({ page: '/stopped', isAppPath: false })

        assert.deepStrictEqual(flushResources(), [])
        assert.strictEqual(nextRouteCh.hasSubscribers, false)
      })
    })

    describe('on failed request', () => {
      let capturedRequestType

      beforeEach(() => {
        capturedRequestType = undefined

        sendData.callsFake((config, application, host, reqType, payload, cb = () => {}) => {
          capturedRequestType = reqType
          cb(new Error('HTTP request error'), { payload, reqType })
        })
      })

      it('should update retry data', () => {
        fastifyRouteCh.publish({ routeOptions: { method: 'GET', path: '/r' } })

        scheduledCallbacks.forEach(cb => cb())

        sinon.assert.calledOnce(getRetryData)
        assert.strictEqual(capturedRequestType, 'app-endpoints')
        sinon.assert.calledOnce(updateRetryData)
      })

      it('should create batch request when retry data exists', () => {
        fastifyRouteCh.publish({ routeOptions: { method: 'GET', path: '/first' } })

        scheduledCallbacks.forEach(cb => cb())

        sinon.assert.calledOnce(getRetryData)
        assert.strictEqual(capturedRequestType, 'app-endpoints')

        getRetryData.returns({
          reqType: 'app-endpoints',
          payload: { endpoints: [] },
        })

        fastifyRouteCh.publish({ routeOptions: { method: 'POST', path: '/second' } })
        scheduledCallbacks.forEach(cb => cb())
        sinon.assert.calledTwice(getRetryData)
        assert.strictEqual(capturedRequestType, 'message-batch')
        sinon.assert.calledTwice(updateRetryData)
      })
    })
  })
})
