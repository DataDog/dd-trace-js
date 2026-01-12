'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const dc = require('dc-polyfill')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
require('../setup/core')

const originalSetImmediate = global.setImmediate

describe('endpoints telemetry', () => {
  const fastifyRouteCh = dc.channel('apm:fastify:route:added')
  const expressRouteCh = dc.channel('apm:express:route:added')
  const routerRouteCh = dc.channel('apm:router:route:added')
  const application = 'test'
  const host = 'host'

  describe('start', () => {
    const subscribe = sinon.stub()
    const dc = { channel () { return { subscribe } } }
    const endpoints = proxyquire('../../src/telemetry/endpoints', {
      'dc-polyfill': dc
    })

    beforeEach(() => {
      sinon.reset()
    })

    it('should subscribe', () => {
      const config = { appsec: { apiSecurity: { endpointCollectionEnabled: true } } }
      endpoints.start(config)

      sinon.assert.calledThrice(subscribe)
    })

    it('should not subscribe', () => {
      const config = { appsec: { apiSecurity: { endpointCollectionEnabled: false } } }
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
        './send-data': { sendData }
      })
      scheduledCallbacks = []
      global.setImmediate = function (callback) {
        scheduledCallbacks.push(callback)
        return { unref () {} }
      }

      const config = {
        appsec: {
          apiSecurity: {
            endpointCollectionEnabled: true,
            endpointCollectionMessageLimit: 100
          }
        }
      }

      endpoints.start(config, application, host, getRetryData, updateRetryData)
    })

    afterEach(() => {
      endpoints.stop()
      sendData.reset()
      getRetryData.reset()
      updateRetryData.reset()
      global.setImmediate = originalSetImmediate
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
          resource_name: 'GET /api'
        },
        {
          type: 'REST',
          method: 'POST',
          path: '/api',
          operation_name: 'fastify.request',
          resource_name: 'POST /api'
        },
        {
          type: 'REST',
          method: 'PUT',
          path: '/api',
          operation_name: 'fastify.request',
          resource_name: 'PUT /api'
        }
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
          resource_name: 'POST /express-test'
        }
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
          resource_name: 'DELETE /router-test'
        }
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
          payload: { endpoints: [] }
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
